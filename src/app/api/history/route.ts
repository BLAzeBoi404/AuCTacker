import { NextRequest, NextResponse } from "next/server";
import { ExboApiError, fetchHistoryAll, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

// История меняется медленнее лотов — кэш на минуту.
const HIST_TTL_MS = 60_000;
interface HistCacheEntry {
  exp: number;
  payload: unknown;
}
const histCache = new Map<string, HistCacheEntry>();

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = Math.min(1000, Math.max(1, Number(searchParams.get("limit") || 400)));

  if (!itemId) {
    return NextResponse.json({ success: false, history: [], total: 0, error: "itemId_required" });
  }

  const cacheKey = `${itemId.toLowerCase()}|${region}|${limit}`;
  const cached = histCache.get(cacheKey);
  if (cached && Date.now() < cached.exp) {
    return NextResponse.json({ ...(cached.payload as Record<string, unknown>), cached: true });
  }

  try {
    const { history: all, total } = await fetchHistoryAll(itemId, region, limit);

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

    const payload = {
      success: true,
      history,
      total,
      stats,
      region,
      source: "EXBO EAPI",
      fetchedAt: new Date().toISOString(),
    };
    histCache.set(cacheKey, { exp: Date.now() + HIST_TTL_MS, payload });
    if (histCache.size > 200) {
      const first = histCache.keys().next().value;
      if (first) histCache.delete(first);
    }
    return NextResponse.json({ success: true, history, total, stats, region, source: "EXBO EAPI", fetchedAt: payload.fetchedAt });
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
