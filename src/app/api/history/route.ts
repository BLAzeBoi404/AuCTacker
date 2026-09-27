import { NextRequest, NextResponse } from "next/server";
import { ExboApiError, fetchHistory, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get("limit") || 400)));

  if (!itemId) {
    return NextResponse.json({ success: false, history: [], total: 0, error: "itemId_required" });
  }

  try {
    const pageSize = 100;
    let all: Awaited<ReturnType<typeof fetchHistory>>["history"] = [];
    let total = 0;
    for (let off = 0; off < limit; off += pageSize) {
      const chunkLimit = Math.min(pageSize, limit - off);
      const r = await fetchHistory(itemId, region, chunkLimit, off);
      total = r.total;
      if (r.history.length === 0) break;
      all = all.concat(r.history);
      if (r.history.length < chunkLimit) break;
    }

    // Сортируем по времени (новые сверху) — API иногда отдаёт вперемешку
    all.sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });

    const history = all.map((h, i) => ({
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

    return NextResponse.json({ success: true, history, total, stats, region, source: "EXBO EAPI", fetchedAt: new Date().toISOString() });
  } catch (e) {
    const message = e instanceof ExboApiError ? e.message : "Не удалось загрузить историю EXBO";
    const status = e instanceof ExboApiError ? e.status : 502;
    console.error("GET /api/history failed:", message);
    return NextResponse.json(
      { success: false, history: [], total: 0, error: "history_failed", message, source: "EXBO EAPI" },
      { status },
    );
  }
}
