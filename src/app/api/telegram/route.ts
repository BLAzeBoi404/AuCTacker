import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { telegramChats } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getSetting, setSetting } from "@/lib/settings";
import { getOwnerKey, isAdmin } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";
import {
  getBotToken,
  getBotUsername,
  createLinkCode,
  pollTelegramUpdates,
  sendTelegramMessage,
  esc,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

// GET — статус Telegram для текущего пользователя (свой привязанный чат)
export async function GET() {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const token = await getBotToken();
    let username = await getSetting("telegram_bot_username");
    if (token && !username) username = await getBotUsername(true);

    const [myChat] = await db
      .select()
      .from(telegramChats)
      .where(and(eq(telegramChats.ownerKey, owner), eq(telegramChats.isActive, true)));

    return NextResponse.json({
      success: true,
      botReady: !!token,
      botUsername: username,
      enabled: ((await getSetting("telegram_enabled")) ?? "1") === "1",
      linked: !!myChat,
      myChat: myChat
        ? { name: myChat.name, username: myChat.username, linkedAt: myChat.linkedAt }
        : null,
    });
  } catch (e) {
    console.error("GET /api/telegram failed:", e);
    return NextResponse.json({ success: false, linked: false });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const admin = await isAdmin();
    const body = (await req.json()) as {
      action?: string;
      token?: string;
    };
    const action = body.action;

    // ---------- Пользовательские действия ----------

    // Получить код для привязки СВОЕГО телеграма
    if (action === "link-code") {
      if (!(await getBotToken())) {
        return NextResponse.json({ success: false, error: "no_bot" });
      }
      const code = await createLinkCode(owner);
      const username = await getBotUsername();
      return NextResponse.json({
        success: true,
        code,
        deepLink: username ? `https://t.me/${username}?start=${code}` : null,
        botUsername: username,
        expiresIn: 900,
      });
    }

    // Проверить входящие сообщения бота (подтвердить привязку сразу)
    if (action === "poll") {
      const r = await pollTelegramUpdates();
      const [myChat] = await db
        .select()
        .from(telegramChats)
        .where(and(eq(telegramChats.ownerKey, owner), eq(telegramChats.isActive, true)));
      return NextResponse.json({ success: r.ok, linked: !!myChat });
    }

    // Отправить тест В СВОЙ чат
    if (action === "test") {
      const [myChat] = await db
        .select()
        .from(telegramChats)
        .where(and(eq(telegramChats.ownerKey, owner), eq(telegramChats.isActive, true)));
      if (!myChat) {
        return NextResponse.json({ success: false, error: "not_linked" });
      }
      const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
      const html =
        `🔔 <b>Тест AucTracker</b>\n\nВсё работает — сюда будут приходить уведомления по вашим трекерам.` +
        (siteUrl ? `\n\nСайт: ${esc(siteUrl)}` : "");
      const ok = await sendTelegramMessage(myChat.chatId, html, siteUrl || undefined);
      return NextResponse.json({ success: ok });
    }

    // Отвязать СВОЙ чат
    if (action === "unlink") {
      await db
        .update(telegramChats)
        .set({ isActive: false })
        .where(eq(telegramChats.ownerKey, owner));
      return NextResponse.json({ success: true });
    }

    // ---------- Админские действия (нужен пароль админки) ----------

    if (action === "save-token" || action === "delete-token") {
      if (!admin) {
        return NextResponse.json({ success: false, error: "admin_only" }, { status: 403 });
      }
      if (action === "delete-token") {
        await setSetting("telegram_bot_token", "");
        await setSetting("telegram_bot_username", "");
        return NextResponse.json({ success: true });
      }
      const token = (body.token || "").trim();
      if (!token || !token.includes(":")) {
        return NextResponse.json({ success: false, error: "bad_token" });
      }
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: "POST" });
      const j = (await r.json()) as { ok: boolean; result?: { username?: string } };
      if (!j.ok || !j.result?.username) {
        return NextResponse.json({ success: false, error: "invalid_token" });
      }
      await setSetting("telegram_bot_token", token);
      await setSetting("telegram_bot_username", j.result.username);
      return NextResponse.json({ success: true, botUsername: j.result.username });
    }

    return NextResponse.json({ success: false, error: "unknown_action" }, { status: 400 });
  } catch (e) {
    console.error("POST /api/telegram failed:", e);
    return NextResponse.json({ success: false, error: "failed" }, { status: 500 });
  }
}
