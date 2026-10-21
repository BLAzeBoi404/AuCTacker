import { NextRequest, NextResponse } from "next/server";
import { ExboApiError, fetchLotsAll, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";
import { AsyncCache } from "@/lib/async-cache";
import { boundedInt, validItemId } from "@/lib/validation";

export const dynamic = "force-dynamic";

const cache = new AsyncCache(25000, 200);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = boundedInt(searchParams.get("limit"), 200, 1, 500);

  if (!validItemId(itemId)) {
    return NextResponse.json({ success: false, lots: [], total: 0, error: "itemId_required" });
  }

  const cacheKey = `${itemId}|${region}|${limit}`;
  try {
    const payload = await cache.get(cacheKey, async () => {
      const { lots: all, total, complete } = await fetchLotsAll(itemId, region, limit);

      const lots = all.map((l) => ({
        ...l,
        qualityName: QUALITY_NAMES[l.quality] ?? "Неизвестна",
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

      return {
        success: true,
        lots,
        total,
        complete,
        stats,
        region,
        source: "EXBO EAPI",
        fetchedAt: new Date().toISOString(),
      };
    });
    return NextResponse.json(payload);
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
