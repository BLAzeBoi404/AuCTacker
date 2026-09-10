import { NextResponse } from "next/server";
import { runTrackerCheck } from "@/lib/tracker-check";
import { ensureScheduler } from "@/lib/scheduler";
import { isAdmin } from "@/lib/identity";

export const dynamic = "force-dynamic";

// Ручной запуск проверки — только для админа (кнопка «Проверить сейчас» в админке).
// Обычная проверка идёт в фоне (планировщик + внешний cron), нагрузку на неё
// пользователи не создают.
export async function POST() {
  void ensureScheduler();
  if (!(await isAdmin())) {
    return NextResponse.json({ success: false, error: "admin_only" }, { status: 403 });
  }
  try {
    const r = await runTrackerCheck("manual");
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    console.error("POST /api/trackers/check failed:", e);
    return NextResponse.json(
      { success: false, matches: [], error: "check_failed" },
      { status: 500 }
    );
  }
}
