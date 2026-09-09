import { db } from "@/db";
import { telegramChats, trackers } from "@/db/schema";
import { eq } from "drizzle-orm";
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
  { chatId: string; name: string | null }[]
> {
  try {
    const rows = await db.select().from(telegramChats);
    return rows
      .filter((r) => r.isActive)
      .map((r) => ({ chatId: r.chatId, name: r.name }));
  } catch {
    return [];
  }
}

interface PendingCode {
  code: string;
  createdAt: number;
}

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

async function getPendingCodes(): Promise<PendingCode[]> {
  try {
    const raw = await getSetting("telegram_link_codes");
    const arr: PendingCode[] = raw ? (JSON.parse(raw) as PendingCode[]) : [];
    const now = Date.now();
    return arr.filter((c) => now - c.createdAt < 15 * 60 * 1000);
  } catch {
    return [];
  }
}

// Каждый пользователь получает свой код — можно привязывать несколько человек
export async function createLinkCode(): Promise<string> {
  const codes = await getPendingCodes();
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  codes.push({ code, createdAt: Date.now() });
  await setSetting("telegram_link_codes", JSON.stringify(codes.slice(-10)));
  return code;
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
        const codes = await getPendingCodes();
        if (code && codes.some((c) => c.code === code)) {
          await db
            .insert(telegramChats)
            .values({
              chatId,
              name,
              username: msg.chat.username || null,
              isActive: true,
            })
            .onConflictDoUpdate({
              target: telegramChats.chatId,
              set: { name, isActive: true, linkedAt: new Date() },
            });
          await setSetting(
            "telegram_link_codes",
            JSON.stringify(codes.filter((c) => c.code !== code))
          );
          linked.push(chatId);
          await sendTelegramMessage(
            chatId,
            `✅ <b>Telegram привязан!</b>\n\nСюда будут приходить уведомления о найденных лотах.` +
              (siteUrl ? `\n\nСайт: ${esc(siteUrl)}` : "")
          );
        } else {
          await sendTelegramMessage(
            chatId,
            `👋 <b>AucTracker</b>\n\nЧтобы привязать уведомления:\n` +
              `1. Откройте сайт → Настройки → Telegram\n` +
              `2. Нажмите «Получить код»\n` +
              `3. Отправьте сюда: <code>/start КОД</code>`
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
        const all = await db.select().from(trackers);
        await sendTelegramMessage(
          chatId,
          `📊 <b>AucTracker</b>\nТрекеров: ${all.length} (активно: ${all.filter((t) => t.enabled).length})\nЧат: <code>${esc(chatId)}</code>`
        );
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
