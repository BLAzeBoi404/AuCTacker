import type { NormalizedHistory, NormalizedLot } from "./auction-data";

export interface BuyConditions {
  upgradeMode: string;
  qualityMode: string;
  targetUpgrade: number;
  targetQuality: number;
  minPrice: number;
  maxPrice: number;
}

export function buyLotMatches(lot: NormalizedLot, tracker: BuyConditions): boolean {
  const price = lot.buyoutPrice || lot.startPrice;
  const upgrade = tracker.upgradeMode === "any" || (lot.upgrade >= 0 && (
    tracker.upgradeMode === "min" ? lot.upgrade >= tracker.targetUpgrade : lot.upgrade === tracker.targetUpgrade
  ));
  const quality = tracker.targetQuality === -1 || (lot.quality >= 0 && (
    tracker.qualityMode === "min" ? lot.quality >= tracker.targetQuality : lot.quality === tracker.targetQuality
  ));
  return upgrade && quality && (tracker.maxPrice === 0 || (price > 0 && price <= tracker.maxPrice))
    && (tracker.minPrice === 0 || (price > 0 && price >= tracker.minPrice));
}

export interface SellConditions {
  targetLotId: string | null;
  price: number;
  amount: number;
  upgrade: number;
  quality: number;
  expectedEndTime: Date | null;
  startTime?: Date | null;
  createdAt: Date | null;
  lastSeenAt: Date | null;
  firstMissingAt: Date | null;
  missCount: number;
}

export function sellLotMatches(lot: NormalizedLot, sell: SellConditions): boolean {
  // Если привязали конкретный ID, похожой чужой лот его не заменяет.
  if (sell.targetLotId) return lot.id === sell.targetLotId || lot.legacyId === sell.targetLotId;
  if (lot.quality < 0 || lot.upgrade < 0 || !sell.expectedEndTime || !lot.endTime) return false;
  return (lot.buyoutPrice || lot.startPrice) === sell.price && lot.amount === sell.amount
    && lot.upgrade === sell.upgrade && lot.quality === sell.quality
    && Math.abs(Date.parse(lot.endTime) - sell.expectedEndTime.getTime()) <= 1000
    && (!sell.startTime || !lot.startTime || Math.abs(Date.parse(lot.startTime) - sell.startTime.getTime()) <= 1000);
}

export const SALE_GRACE_MS = 15 * 60_000;
export const MISSING_GRACE_MS = 30 * 60_000;

export function findSale(sell: SellConditions, history: NormalizedHistory[], now: number): NormalizedHistory | null {
  if (sell.quality < 0 || sell.upgrade < 0) return null;
  const since = Math.max(sell.createdAt?.getTime() ?? 0, sell.lastSeenAt?.getTime() ?? 0) - 5000;
  const until = Math.min(now + 5000, (sell.expectedEndTime?.getTime() ?? now) + 120_000);
  const hits = history.filter((h) => h.price === sell.price && h.amount === sell.amount
    && h.upgrade === sell.upgrade && h.quality === sell.quality && h.time
    && Date.parse(h.time) >= since && Date.parse(h.time) <= until);
  return hits.length === 1 ? hits[0] : null;
}

export type SaleDecision = { status: "sold" | "expired" | "removed"; finishedAt: Date; price: number | null } | null;

export function decideMissingSale(
  sell: SellConditions,
  history: NormalizedHistory[] | null,
  historyComplete: boolean,
  now: number,
): SaleDecision {
  if (sell.missCount < 2) return null;
  const hit = history ? findSale(sell, history, now) : null;
  // Проверяем дату сделки, а не дату нынешней проверки: сервер мог долго спать.
  if (hit?.time) return { status: "sold", finishedAt: new Date(hit.time), price: hit.price };
  const end = sell.expectedEndTime?.getTime();
  const firstMissing = sell.firstMissingAt?.getTime() ?? now;
  if (end !== undefined && now >= end + SALE_GRACE_MS) {
    // Неполная история не позволяет уверенно отличить продажу от снятия лота.
    const unknownSale = history?.some((h) => h.price === sell.price && h.amount === sell.amount
      && (h.quality < 0 || h.upgrade < 0) && h.time
      && Date.parse(h.time) >= (sell.createdAt?.getTime() ?? 0) - 5000);
    const certain = history !== null && historyComplete && sell.quality >= 0 && sell.upgrade >= 0 && !unknownSale;
    return { status: certain ? "expired" : "removed", finishedAt: new Date(end), price: null };
  }
  if (now - firstMissing >= MISSING_GRACE_MS) {
    return { status: "removed", finishedAt: new Date(firstMissing), price: null };
  }
  return null;
}
