export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export const MAX_PRICE = Number.MAX_SAFE_INTEGER;

export function validItemId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
}

export function validPrice(value: unknown): boolean {
  return (typeof value === "number" || typeof value === "string")
    && String(value).trim() !== ""
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function trackerConditionsError(body: Record<string, unknown>): string | null {
  if (body.upgradeMode !== undefined && !["exact", "min", "any"].includes(String(body.upgradeMode))) return "Неверный режим заточки.";
  if (body.qualityMode !== undefined && !["exact", "min"].includes(String(body.qualityMode))) return "Неверный режим редкости.";
  if (body.targetUpgrade !== undefined && (!validPrice(body.targetUpgrade) || Number(body.targetUpgrade) > 30)) return "Заточка должна быть целым числом от 0 до 30.";
  if (body.targetQuality !== undefined && (!(typeof body.targetQuality === "number" || typeof body.targetQuality === "string") || String(body.targetQuality).trim() === "" || ![-1, 0, 1, 2, 3, 4, 5].includes(Number(body.targetQuality)))) return "Неверная редкость.";
  for (const key of ["minPrice", "maxPrice"]) {
    if (body[key] !== undefined && !validPrice(body[key])) return "Цена должна быть целым неотрицательным числом.";
  }
  if (Number(body.maxPrice) > 0 && Number(body.minPrice) > Number(body.maxPrice)) return "Цена от не может быть больше цены до.";
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return "Неверное состояние трекера.";
  if (body.region !== undefined && !["EU", "RU", "NA"].includes(String(body.region).toUpperCase())) return "Неверный регион.";
  return null;
}
