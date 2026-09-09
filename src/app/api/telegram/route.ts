import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { telegramChats } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { getSetting, setSetting } from "@/lib/settings";
import {
  getBotToken,
  getBotUsername,
  createLinkCode,
  pollTelegramUpdates,
  sendTelegramMessage,
  getActiveChats,
  esc,
} from "@/lib/telegram";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const token = await getBotToken();
    const chats = await db
      .select()
      .from(telegramChats)
      .orderBy(desc(telegramChats.linkedAt));
    let username = await getSetting("telegram_bot_username");
    if (token && !username) username = await getBotUsername(true);
    return NextResponse.json({
      success: true,
      hasToken: !!token,
      botUsername: username,
      enabled: ((await getSetting("telegram_enabled")) ?? "1") === "1",
      chats,
    });
  } catch (e) {
    console.error("GET /api/telegram failed:", e);
    return NextResponse.json({ success: false, chats: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: string;
      token?: string;
      chatId?: string;
    };
    const action = body.action;

    if (action === "save-token") {
      const token = (body.token || "").trim();
      if (!token || !token.includes(":")) {
        return NextResponse.json({ success: false, error: "bad_token" });
      }
      // Проверяем токен напрямую у Telegram
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
        method: "POST",
      });
      const j = (await r.json()) as {
        ok: boolean;
        result?: { username?: string };
      };
      if (!j.ok || !j.result?.username) {
        return NextResponse.json({ success: false, error: "invalid_token" });
      }
      await setSetting("telegram_bot_token", token);
      await setSetting("telegram_bot_username", j.result.username);
      return NextResponse.json({
        success: true,
        botUsername: j.result.username,
      });
    }

    if (action === "delete-token") {
      await setSetting("telegram_bot_token", "");
      await setSetting("telegram_bot_username", "");
      return NextResponse.json({ success: true });
    }

    if (action === "link-code") {
      if (!(await getBotToken())) {
        return NextResponse.json({ success: false, error: "no_token" });
      }
      const code = await createLinkCode();
      const username = await getBotUsername();
      return NextResponse.json({
        success: true,
        code,
        deepLink: username ? `https://t.me/${username}?start=${code}` : null,
        botUsername: username,
        expiresIn: 900,
      });
    }

    if (action === "poll") {
      const r = await pollTelegramUpdates();
      return NextResponse.json({ success: r.ok, linked: r.linked });
    }

    if (action === "test") {
      if (!(await getBotToken())) {
        return NextResponse.json({ success: false, error: "no_token" });
      }
      const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
      const html =
        `🔔 <b>Тестовое уведомление AucTracker</b>\n\n` +
        `Всё настроено правильно — сюда будут приходить найденные лоты.` +
        (siteUrl ? `\n\nСайт: ${esc(siteUrl)}` : "");
      if (body.chatId) {
        const ok = await sendTelegramMessage(
          body.chatId,
          html,
          siteUrl || undefined
        );
        return NextResponse.json({ success: ok });
      }
      const chats = await getActiveChats();
      let sent = 0;
      for (const c of chats) {
        if (await sendTelegramMessage(c.chatId, html, siteUrl || undefined))
          sent++;
      }
      return NextResponse.json({ success: true, sent, total: chats.length });
    }

    if (action === "unlink") {
      if (!body.chatId) {
        return NextResponse.json({ success: false }, { status: 400 });
      }
      await db
        .update(telegramChats)
        .set({ isActive: false })
        .where(eq(telegramChats.chatId, body.chatId));
      return NextResponse.json({ success: true });
    }

    return NextResponse.json(
      { success: false, error: "unknown_action" },
      { status: 400 }
    );
  } catch (e) {
    console.error("POST /api/telegram failed:", e);
    return NextResponse.json({ success: false, error: "failed" }, { status: 500 });
  }
}
