import { NextRequest, NextResponse } from "next/server";
import { fetchLotsPages, fetchLotExtremes, normalizeRegion, type NormalizedLot } from "@/lib/exbo";
import { QUALITY_NAMES } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const itemId = (searchParams.get("itemId") || "").toLowerCase().trim();
  const region = normalizeRegion(searchParams.get("region"));
  const limit = Math.min(500, Math.max(1, Number(searchParams.get("limit") || 200)));

  if (!itemId) {
    return NextResponse.json({ success: false, lots: [], total: 0, error: "itemId_required" });
  }

  try {
    const pages = Math.ceil(limit / 100);
    // Параллельно: (1) список лотов от дешёвых к дорогим — то, что реально
    // интересно пользователю, и (2) точные min/max по ВСЕМ лотам предмета,
    // а не только по подгруженной странице — иначе самый дорогой лот из
    // сотен активных мог "потеряться" за пределами выборки.
    const [pageRes, extremes] = await Promise.all([
      fetchLotsPages(itemId, region, pages, "buyout_price", "asc"),
      fetchLotExtremes(itemId, region),
    ]);

    const byId = new Map<string, NormalizedLot>();
    for (const l of pageRes.lots) byId.set(l.id, l);
    // Гарантируем, что абсолютный максимум/минимум всегда присутствуют в
    // наборе — иначе фильтры по заточке/редкости могли бы его случайно скрыть.
    if (extremes.max) byId.set(extremes.max.id, extremes.max);
    if (extremes.min) byId.set(extremes.min.id, extremes.min);

    const merged = Array.from(byId.values());
    const total = Math.max(pageRes.total, extremes.total);

    const lots = merged.map((l) => ({
      ...l,
      qualityName: QUALITY_NAMES[l.quality] ?? "Обычный",
      pricePerUnit:
        l.amount > 1
          ? Math.round((l.buyoutPrice || l.startPrice) / l.amount)
          : l.buyoutPrice || l.startPrice,
    }));

    const truePrices = [extremes.min, extremes.max]
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((l) => l.buyoutPrice || l.startPrice)
      .filter((p) => p > 0);
    const samplePrices = lots.map((l) => l.buyoutPrice || l.startPrice).filter((p) => p > 0);
    const allPrices = samplePrices.length ? samplePrices : truePrices;

    const stats = allPrices.length
      ? {
          // min/max берём из точного запроса (всегда верны), avg — по загруженной выборке
          min: truePrices.length ? Math.min(...truePrices) : Math.min(...allPrices),
          max: truePrices.length ? Math.max(...truePrices) : Math.max(...allPrices),
          avg: Math.round(samplePrices.reduce((a, b) => a + b, 0) / (samplePrices.length || 1)),
          count: total,
        }
      : { min: 0, max: 0, avg: 0, count: total };

    return NextResponse.json({ success: true, lots, total, stats, region });
  } catch (e) {
    console.error("GET /api/lots failed:", e);
    return NextResponse.json({ success: false, lots: [], total: 0, error: "lots_failed" });
  }
}
