import { NextRequest, NextResponse } from "next/server";
import { fetchHistory, fetchLots, normalizeRegion } from "@/lib/exbo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").toLowerCase().trim();
  const region = normalizeRegion(searchParams.get("region"));
  if (!itemId) return NextResponse.json({ success: false, error: "itemId_required" });

  try {
    const [lotsRes, histRes] = await Promise.all([
      fetchLots(itemId, region, 100, 0),
      fetchHistory(itemId, region, 100, 0),
    ]);

    // Цены за штуку: в API суммы указаны за весь стак, делим на количество
    const perUnit = (price: number, amount: number) =>
      amount > 1 ? Math.round(price / amount) : price;
    const lotPrices = lotsRes.lots
      .map((l) => perUnit(l.buyoutPrice || l.startPrice, l.amount))
      .filter((p) => p > 0);
    const histPrices = histRes.history
      .map((h) => perUnit(h.price, h.amount))
      .filter((p) => p > 0);

    const histSorted = [...histRes.history].sort((a, b) => {
      const ta = a.time ? new Date(a.time).getTime() : 0;
      const tb = b.time ? new Date(b.time).getTime() : 0;
      return tb - ta;
    });

    // Изменение за 24ч
    const now = Date.now();
    const last24 = histSorted.filter((h) => h.time && now - new Date(h.time).getTime() < 86400000);
    const prev24 = histSorted.filter(
      (h) => h.time && now - new Date(h.time).getTime() >= 86400000 && now - new Date(h.time).getTime() < 172800000
    );
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const avg24 = avg(last24.map((h) => h.price).filter((p) => p > 0));
    const avgPrev = avg(prev24.map((h) => h.price).filter((p) => p > 0));
    const change24 = avgPrev > 0 ? ((avg24 - avgPrev) / avgPrev) * 100 : 0;

    return NextResponse.json({
      success: true,
      region,
      lots: {
        count: lotsRes.total,
        min: lotPrices.length ? Math.min(...lotPrices) : 0,
        max: lotPrices.length ? Math.max(...lotPrices) : 0,
        avg: lotPrices.length ? Math.round(avg(lotPrices)) : 0,
      },
      history: {
        count: histRes.total,
        last: histSorted.find((h) => h.price > 0)?.price || 0,
        min: histPrices.length ? Math.min(...histPrices) : 0,
        max: histPrices.length ? Math.max(...histPrices) : 0,
        avg: histPrices.length ? Math.round(avg(histPrices)) : 0,
        change24: Math.round(change24 * 10) / 10,
      },
    });
  } catch (e) {
    console.error("GET /api/stats failed:", e);
    return NextResponse.json({ success: false, error: "stats_failed" });
  }
}
