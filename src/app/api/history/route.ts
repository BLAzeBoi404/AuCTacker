import { NextRequest, NextResponse } from "next/server";
import { fetchHistoryPages, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").toLowerCase().trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get("limit") || 400)));

  if (!itemId) {
    return NextResponse.json({ success: false, history: [], total: 0, error: "itemId_required" });
  }

  try {
    // Все страницы запрашиваются параллельно — в разы быстрее
    // последовательного перебора (EAPI поддерживает максимум 100 за запрос).
    const pages = Math.ceil(limit / 100);
    const { history: all, total } = await fetchHistoryPages(itemId, region, pages);

    const history = all.slice(0, limit).map((h, i) => ({
      ...h,
      id: `${h.id}-${i}`,
      qualityName: QUALITY_NAMES[h.quality] ?? "Обычный",
    }));

    const prices = history.map((h) => h.price).filter((p) => p > 0);
    const stats =
      prices.length > 0
        ? {
            last: history.find((h) => h.price > 0)?.price || 0,
            min: Math.min(...prices),
            max: Math.max(...prices),
            avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
            count: history.length,
          }
        : { last: 0, min: 0, max: 0, avg: 0, count: history.length };

    return NextResponse.json({ success: true, history, total, stats, region });
  } catch (e) {
    console.error("GET /api/history failed:", e);
    return NextResponse.json({ success: false, history: [], total: 0, error: "history_failed" });
  }
}
