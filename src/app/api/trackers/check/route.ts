import { NextResponse } from "next/server";
import { runTrackerCheck } from "@/lib/tracker-check";
import { ensureScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

// Ручная проверка из сайта (кнопка "Проверить сейчас" + авточек открытой вкладки)
export async function GET() {
  void ensureScheduler();
  try {
    const r = await runTrackerCheck("manual");
    return NextResponse.json({ success: true, ...r });
  } catch (e) {
    console.error("GET /api/trackers/check failed:", e);
    return NextResponse.json(
      { success: false, matches: [], error: "check_failed" },
      { status: 500 }
    );
  }
}

export async function POST() {
  return GET();
}
