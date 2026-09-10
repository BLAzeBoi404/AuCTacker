import { NextRequest, NextResponse } from "next/server";
import { ExboApiError, fetchLots, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") || 200)));
  const offset = Math.max(0, Number(searchParams.get("offset") || 0));

  if (!itemId) {
    return NextResponse.json({ success: false, lots: [], total: 0, error: "itemId_required" });
  }

  try {
    // Подгружаем до 1000 лотов постранично (API отдаёт максимум 100 за раз)
    const pageSize = 100;
    let all: Awaited<ReturnType<typeof fetchLots>>["lots"] = [];
    let total = 0;
    const need = Math.min(limit, 1000);
    for (let off = offset; off < offset + need; off += pageSize) {
      const chunkLimit = Math.min(pageSize, offset + need - off);
      const r = await fetchLots(itemId, region, chunkLimit, off);
      total = r.total;
      if (r.lots.length === 0) break;
      all = all.concat(r.lots);
      if (r.lots.length < chunkLimit) break;
      if (all.length >= need) break;
    }
    all = all.slice(0, need);

    const lots = all.map((l) => ({
      ...l,
      qualityName: QUALITY_NAMES[l.quality] ?? "Обычный",
      pricePerUnit: l.amount > 1 ? Math.round((l.buyoutPrice || l.startPrice) / l.amount) : (l.buyoutPrice || l.startPrice),
    }));

    // Статистика по активным лотам
    const prices = lots.map((l) => l.buyoutPrice || l.startPrice).filter((p) => p > 0);
    const stats =
      prices.length > 0
        ? {
            min: Math.min(...prices),
            max: Math.max(...prices),
            avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
            count: lots.length,
          }
        : { min: 0, max: 0, avg: 0, count: lots.length };

    return NextResponse.json({
      success: true,
      lots,
      total,
      stats,
      region,
      source: "EXBO EAPI",
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof ExboApiError ? e.message : "Не удалось загрузить официальный аукцион EXBO";
    const status = e instanceof ExboApiError ? e.status : 502;
    console.error("GET /api/lots failed:", message);
    return NextResponse.json(
      { success: false, lots: [], total: 0, error: "lots_failed", message, source: "EXBO EAPI" },
      { status },
    );
  }
}
