import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting, getOrCreateSecret } from "@/lib/settings";
import { getSchedulerStatus, ensureScheduler } from "@/lib/scheduler";
import { getBotUsername } from "@/lib/telegram";

export const dynamic = "force-dynamic";

const PUBLIC_KEYS = [
  "scheduler_enabled",
  "scheduler_interval",
  "site_url",
  "telegram_enabled",
] as const;

export async function GET() {
  void ensureScheduler();
  try {
    const values: Record<string, string> = {};
    for (const k of PUBLIC_KEYS) values[k] = (await getSetting(k)) ?? "";
    const token = await getSetting("telegram_bot_token");
    const hasToken =
      !!(token && token.trim()) || !!process.env.TELEGRAM_BOT_TOKEN;
    let botUsername = await getSetting("telegram_bot_username");
    if (hasToken && !botUsername) botUsername = await getBotUsername(true);
    const cronSecret = await getOrCreateSecret();
    const scheduler = await getSchedulerStatus();
    return NextResponse.json({
      success: true,
      settings: {
        ...values,
        telegram_has_token: hasToken ? "1" : "",
        telegram_bot_username: botUsername || "",
        cron_secret: cronSecret,
      },
      scheduler,
    });
  } catch (e) {
    console.error("GET /api/settings failed:", e);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

const ALLOWED = new Set([
  "scheduler_enabled",
  "scheduler_interval",
  "site_url",
  "telegram_enabled",
]);

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      values?: Record<string, string>;
    };
    const values = body.values || {};
    for (const [k, v] of Object.entries(values)) {
      if (!ALLOWED.has(k)) continue;
      let val = String(v ?? "");
      if (k === "scheduler_enabled" || k === "telegram_enabled")
        val = val === "1" ? "1" : "0";
      if (k === "scheduler_interval")
        val = String(Math.min(3600, Math.max(30, Number(val) || 600)));
      if (k === "site_url") val = val.trim().replace(/\/$/, "");
      await setSetting(k, val);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("PUT /api/settings failed:", e);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
    };
    if (body.action === "regen-cron") {
      const { randomBytes } = await import("crypto");
      const s = randomBytes(18).toString("hex");
      await setSetting("cron_secret", s);
      return NextResponse.json({ success: true, cron_secret: s });
    }
    return NextResponse.json({ success: false }, { status: 400 });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
