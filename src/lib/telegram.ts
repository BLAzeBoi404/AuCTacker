import { db } from "@/db";
import { telegramChats, trackers, telegramCodes } from "@/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { getSetting, setSetting } from "./settings";

export async function getBotToken(): Promise<string | null> {
  const s = await getSetting("telegram_bot_token");
  if (s && s.trim()) return s.trim();
  const env = process.env.TELEGRAM_BOT_TOKEN;
  return env && env.trim() ? env.trim() : null;
}

async function botApi<T>(
  method: string,
  body?: Record<string, unknown>
): Promise<T | null> {
  const token = await getBotToken();
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = (await r.json()) as {
      ok: boolean;
      result: T;
      description?: string;
    };
    if (!j.ok) {
      console.error("TG API error:", method, j.description);
      return null;
    }
    return j.result;
  } catch (e) {
    console.error("TG fetch failed:", method, e);
    return null;
  }
}

export async function getBotUsername(force = false): Promise<string | null> {
  if (!force) {
    const c = await getSetting("telegram_bot_username");
    if (c) return c;
  }
  const me = await botApi<{ username?: string }>("getMe", {});
  if (me?.username) {
    await setSetting("telegram_bot_username", me.username);
    return me.username;
  }
  return null;
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegramMessage(
  chatId: string,
  html: string,
  url?: string
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (url) {
    body.reply_markup = {
      inline_keyboard: [[{ text: "🔎 Открыть аукцион", url }]],
    };
  }
  const r = await botApi("sendMessage", body);
  if (r) {
    try {
      await db
        .update(telegramChats)
        .set({ lastMessageAt: new Date() })
        .where(eq(telegramChats.chatId, chatId));
    } catch {
      /* ignore */
    }
  }
  return !!r;
}

export async function getActiveChats(): Promise<
  { chatId: string; name: string | null; ownerKey: string | null }[]
> {
  try {
    const rows = await db.select().from(telegramChats);
    return rows
      .filter((r) => r.isActive)
      .map((r) => ({ chatId: r.chatId, name: r.name, ownerKey: r.ownerKey }));
  } catch {
    return [];
  }
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_MS = 15 * 60 * 1000;

// Каждый пользователь (профиль браузера) получает свой одноразовый код.
// Код хранится в БД вместе с ownerKey, чтобы Telegram-чат привязался к нужному профилю.
export async function createLinkCode(ownerKey: string): Promise<string> {
  // Чистим просроченные коды
  await db
    .delete(telegramCodes)
    .where(lt(telegramCodes.createdAt, new Date(Date.now() - CODE_TTL_MS)));

  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  await db.insert(telegramCodes).values({ code, ownerKey, createdAt: new Date() });
  return code;
}

// Возвращает ownerKey по коду, если код валиден и не просрочен
async function consumeLinkCode(code: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(telegramCodes)
    .where(eq(telegramCodes.code, code));
  if (!row) return null;
  if (row.createdAt && Date.now() - row.createdAt.getTime() > CODE_TTL_MS) {
    await db.delete(telegramCodes).where(eq(telegramCodes.code, code));
    return null;
  }
  await db.delete(telegramCodes).where(eq(telegramCodes.code, code));
  return row.ownerKey;
}

interface TgUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
    };
    text?: string;
  };
}

// Опрос входящих сообщений бота (без вебхуков — работает на любом хостинге)
export async function pollTelegramUpdates(): Promise<{
  ok: boolean;
  linked: string[];
}> {
  const token = await getBotToken();
  if (!token) return { ok: false, linked: [] };
  const linked: string[] = [];
  try {
    const offRaw = await getSetting("telegram_update_offset");
    const offset = Number(offRaw) || 0;
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout: 0, allowed_updates: ["message"] }),
    });
    const j = (await r.json()) as { ok: boolean; result: TgUpdate[] };
    if (!j.ok) return { ok: false, linked };
    let maxId = offset;
    const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
    for (const u of j.result || []) {
      maxId = Math.max(maxId, u.update_id + 1);
      const msg = u.message;
      if (!msg?.text) continue;
      const chatId = String(msg.chat.id);
      const text = msg.text.trim();
      const name =
        [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") ||
        (msg.chat.username ? `@${msg.chat.username}` : chatId);

      if (text.startsWith("/start")) {
        const parts = text.split(/\s+/);
        const code = (parts[1] || "").toUpperCase();
        const ownerKey = code ? await consumeLinkCode(code) : null;
        if (ownerKey) {
          // Один профиль = один активный чат. Отвязываем старые чаты этого профиля.
          await db
            .update(telegramChats)
            .set({ isActive: false })
            .where(eq(telegramChats.ownerKey, ownerKey));
          await db
            .insert(telegramChats)
            .values({
              chatId,
              ownerKey,
              name,
              username: msg.chat.username || null,
              isActive: true,
            })
            .onConflictDoUpdate({
              target: telegramChats.chatId,
              set: { ownerKey, name, isActive: true, linkedAt: new Date() },
            });
          linked.push(chatId);
          await sendTelegramMessage(
            chatId,
            `✅ <b>Telegram привязан!</b>\n\nСюда будут приходить уведомления по вашим трекерам.` +
              (siteUrl ? `\n\nСайт: ${esc(siteUrl)}` : "")
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `👋 <b>AucTracker</b>\n\nЧтобы получать уведомления:\n` +
              `1. Откройте сайт → Telegram\n` +
              `2. Нажмите «Привязать Telegram»\n` +
              `3. Отправьте сюда: <code>/start КОД</code>\n\n` +
              `Код действует 15 минут.`
          );
        }
      } else if (text === "/stop") {
        await db
          .update(telegramChats)
          .set({ isActive: false })
          .where(eq(telegramChats.chatId, chatId));
        await sendTelegramMessage(
          chatId,
          `🔕 Уведомления отключены.\nЧтобы включить снова — отправьте <code>/start КОД</code> с новым кодом с сайта.`
        );
      } else if (text === "/status") {
        const [chat] = await db
          .select()
          .from(telegramChats)
          .where(eq(telegramChats.chatId, chatId));
        if (chat?.ownerKey) {
          const mine = await db
            .select()
            .from(trackers)
            .where(eq(trackers.ownerKey, chat.ownerKey));
          await sendTelegramMessage(
            chatId,
            `📊 <b>AucTracker</b>\nВаших трекеров: ${mine.length} (активно: ${mine.filter((t) => t.enabled).length})`
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `Этот чат не привязан. Откройте сайт → Telegram → «Привязать Telegram».`
          );
        }
      } else {
        await sendTelegramMessage(
          chatId,
          `Отправьте <code>/start КОД</code> для привязки. Код берётся на сайте в Настройках → Telegram.`
        );
      }
    }
    if (maxId !== offset) {
      await setSetting("telegram_update_offset", String(maxId));
    }
    return { ok: true, linked };
  } catch (e) {
    console.error("TG poll failed:", e);
    return { ok: false, linked };
  }
}
