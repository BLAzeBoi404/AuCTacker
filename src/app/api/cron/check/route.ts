import { NextRequest, NextResponse } from "next/server";
import { runTrackerCheck } from "@/lib/tracker-check";
import { pollTelegramUpdates } from "@/lib/telegram";
import { getOrCreateSecret } from "@/lib/settings";
import { ensureScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

// Внешний cron-пинг (например, cron-job.org каждые 2-5 минут).
// Будит бесплатный хостинг и запускает проверку трекеров + почту Telegram-бота.
// URL: /api/cron/check?secret=XXX (секрет — в Настройках сайта)
export async function GET(req: NextRequest) {
  void ensureScheduler();
  try {
    const { ensureSchema } = await import("@/lib/ensure-schema");
    await ensureSchema();
  } catch {
    /* таблицы создадутся следующим разом, проверку всё равно пробуем */
  }
  const secret = await getOrCreateSecret();
  const got =
    req.nextUrl.searchParams.get("secret") ||
    req.headers.get("x-cron-secret") ||
    "";
  if (got !== secret) {
    return NextResponse.json(
      { success: false, error: "unauthorized" },
      { status: 401 }
    );
  }
  try {
    const r = await runTrackerCheck("cron");
    await pollTelegramUpdates();
    return NextResponse.json({
      success: true,
      source: "cron",
      at: new Date().toISOString(),
      ...r,
    });
  } catch (e) {
    console.error("GET /api/cron/check failed:", e);
    return NextResponse.json(
      { success: false, error: "cron_failed" },
      { status: 500 }
    );
  }
}
