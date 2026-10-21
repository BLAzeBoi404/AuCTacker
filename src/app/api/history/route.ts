import { NextRequest, NextResponse } from "next/server";
import { ExboApiError, fetchHistoryAll, normalizeRegion } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";
import { AsyncCache } from "@/lib/async-cache";
import { boundedInt, validItemId } from "@/lib/validation";

export const dynamic = "force-dynamic";

const cache = new AsyncCache(60000, 200);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = boundedInt(searchParams.get("limit"), 400, 1, 1000);

  if (!validItemId(itemId)) {
    return NextResponse.json({ success: false, history: [], total: 0, error: "itemId_required" });
  }

  const cacheKey = `${itemId}|${region}|${limit}`;
  try {
    const payload = await cache.get(cacheKey, async () => {
      const { history: all, total, complete } = await fetchHistoryAll(itemId, region, limit);

      const history = all.map((h) => ({
        ...h,
        qualityName: QUALITY_NAMES[h.quality] ?? "Неизвестна",
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

      return {
        success: true,
        history,
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
    const message = e instanceof ExboApiError ? e.message : "Не удалось загрузить историю EXBO";
    const status = e instanceof ExboApiError ? e.status : 502;
    console.error("GET /api/history failed:", message);
    return NextResponse.json(
      { success: false, history: [], total: 0, error: "history_failed", message, source: "EXBO EAPI" },
      { status },
    );
  }
}
