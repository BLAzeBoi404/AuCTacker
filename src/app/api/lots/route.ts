import { NextRequest, NextResponse } from "next/server";
import { ExboApiError, fetchLotsAll, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

// Короткий кэш «горячих» предметов: повторные открытия и автообновление
// нескольких друзей не дёргают EXBO по кругу. Трекинг продаж и покупок
// идёт мимо кэша — ему всегда нужны свежие данные.
const LOTS_TTL_MS = 25_000;
interface LotsCacheEntry {
  exp: number;
  payload: unknown;
}
const lotsCache = new Map<string, LotsCacheEntry>();

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") || 200)));

  if (!itemId) {
    return NextResponse.json({ success: false, lots: [], total: 0, error: "itemId_required" });
  }

  const cacheKey = `${itemId.toLowerCase()}|${region}|${limit}`;
  const cached = lotsCache.get(cacheKey);
  if (cached && Date.now() < cached.exp) {
    return NextResponse.json({ ...(cached.payload as Record<string, unknown>), cached: true });
  }

  try {
    const { lots: all, total } = await fetchLotsAll(itemId, region, limit);

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

    const payload = {
      success: true,
      lots,
      total,
      stats,
      region,
      source: "EXBO EAPI",
      fetchedAt: new Date().toISOString(),
    };
    lotsCache.set(cacheKey, { exp: Date.now() + LOTS_TTL_MS, payload });
    if (lotsCache.size > 200) {
      const first = lotsCache.keys().next().value;
      if (first) lotsCache.delete(first);
    }
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
