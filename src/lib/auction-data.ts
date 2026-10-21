// Неизвестные атрибуты сохраняем как -1. Отсутствие qlt — не доказательство
// обычной редкости; цену для определения редкости использовать нельзя.
export const UNKNOWN_ATTRIBUTE = -1;

export interface NormalizedLot {
  id: string;
  legacyId?: string;
  itemId: string;
  startPrice: number;
  buyoutPrice: number;
  amount: number;
  endTime: string | null;
  startTime: string | null;
  upgrade: number;
  quality: number;
}

export interface NormalizedHistory {
  id: string;
  price: number;
  amount: number;
  time: string | null;
  upgrade: number;
  quality: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function number(value: unknown): number | null {
  if (value !== null && typeof value === "object") value = record(value).value;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function integer(value: unknown, fallback = 0): number {
  const n = number(value);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

export function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function parseAdditional(raw: unknown): { upgrade: number; quality: number } {
  const root = record(raw);
  const sources = [record(root.additional), record(root.props), root];
  function attribute(keys: string[], max: number): number {
    for (const src of sources) {
      for (const key of keys) {
        const n = number(src[key]);
        if (n !== null && Number.isInteger(n) && n >= 0 && n <= max) return n;
      }
    }
    return UNKNOWN_ATTRIBUTE;
  }
  return {
    upgrade: attribute(["ptn", "upgrade_level", "upgrade", "enhancement"], 30),
    quality: attribute(["qlt", "quality", "rarity"], 5),
  };
}

// Сохраняем прежний алгоритм: уже привязанные лоты не должны менять ID.
export function stableHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

export function normalizeLot(value: unknown, itemId: string): NormalizedLot {
  const raw = record(value);
  const { upgrade, quality } = parseAdditional(raw);
  const startPrice = integer(raw.startPrice ?? raw.start_price ?? raw.price);
  const buyoutPrice = integer(raw.buyoutPrice ?? raw.buyout_price ?? raw.buyPrice ?? raw.price);
  const amount = Math.max(1, integer(raw.amount ?? raw.count ?? raw.quantity, 1));
  const rawEnd = raw.endTime ?? raw.end_time ?? raw.expiresAt ?? raw.expires_at;
  const rawStart = raw.startTime ?? raw.start_time ?? raw.createdAt ?? raw.created_at;
  const endTime = isoDate(rawEnd);
  const startTime = isoDate(rawStart);
  const rawId = raw.id ?? raw.lotId ?? raw.uuid;
  const fingerprint = (u: number, q: number) =>
    `lot-${stableHash(`${itemId}|${typeof rawStart === "string" ? rawStart : null}|${typeof rawEnd === "string" ? rawEnd : null}|${startPrice}|${buyoutPrice}|${amount}|${u}|${q}`)}`;
  const id = rawId !== undefined && rawId !== null && String(rawId) !== ""
    ? String(rawId) : fingerprint(upgrade, quality);
  // Совместимость со старыми записями, где неизвестное значение записывалось как 0.
  const legacyId = rawId == null && (upgrade < 0 || quality < 0)
    ? fingerprint(Math.max(0, upgrade), Math.max(0, quality)) : undefined;
  return { id, ...(legacyId ? { legacyId } : {}), itemId, startPrice, buyoutPrice, amount, endTime, startTime, upgrade, quality };
}

export function normalizeHistory(value: unknown, idx: number): NormalizedHistory {
  const raw = record(value);
  const { upgrade, quality } = parseAdditional(raw);
  const price = integer(raw.price ?? raw.cost);
  const amount = Math.max(1, integer(raw.amount ?? raw.count, 1));
  const time = isoDate(raw.time ?? raw.date ?? raw.soldAt ?? raw.createdAt);
  const id = raw.id != null && String(raw.id) ? String(raw.id)
    : `h-${stableHash(`${price}|${amount}|${time}|${upgrade}|${quality}|${idx}`)}`;
  return { id, price, amount, time, upgrade, quality };
}
