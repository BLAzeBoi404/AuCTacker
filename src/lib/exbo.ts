import { db } from "@/db";
import { items } from "@/db/schema";
import { sql } from "drizzle-orm";
import { DB_BASE } from "./constants";

// Секреты читаются только из окружения Render/.env и никогда не хранятся в коде.
const CLIENT_ID = process.env.EXBO_CLIENT_ID;
const CLIENT_SECRET = process.env.EXBO_CLIENT_SECRET;

export class ExboApiError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "ExboApiError";
  }
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function getAccessToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new ExboApiError("На сервере не заданы EXBO_CLIENT_ID/EXBO_CLIENT_SECRET", 503);
  }
  let res: Response;
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "",
    });
    res = await fetch("https://exbo.net/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ExboApiError("Сервер авторизации EXBO не ответил", 504);
  }
  if (!res.ok) {
    throw new ExboApiError(`EXBO отклонил авторизацию (HTTP ${res.status})`, 502);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new ExboApiError("EXBO не выдал токен доступа", 502);
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Math.max(30000, (data.expires_in || 3600) * 1000 - 60000);
  return cachedToken;
}

export function normalizeRegion(r: string | null | undefined): string {
  const v = (r || "EU").toUpperCase();
  if (v === "RU" || v === "EU" || v === "NA") return v;
  return "EU";
}

export interface NormalizedLot {
  id: string;
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

function parseAdditional(src: Record<string, unknown> | undefined | null): {
  upgrade: number;
  quality: number;
} {
  const add = (src || {}) as Record<string, number>;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const upgrade =
    add.ptn !== undefined
      ? num(add.ptn)
      : add.upgrade_level !== undefined
        ? num(add.upgrade_level)
        : add.upgrade !== undefined
          ? num(add.upgrade)
          : add.enhancement !== undefined
            ? num(add.enhancement)
            : 0;
  const quality =
    add.qlt !== undefined
      ? num(add.qlt)
      : add.quality !== undefined
        ? num(add.quality)
        : add.rarity !== undefined
          ? num(add.rarity)
          : 0;
  return {
    upgrade: Math.max(0, Math.min(30, Math.round(upgrade))),
    quality: Math.max(0, Math.min(5, Math.round(quality))),
  };
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toStr(v: unknown): string | null {
  if (typeof v === "string" && v) return v;
  return null;
}

// Стабильный хэш для лотов без id (EAPI не возвращает id лота!)
function stableHash(s: string): string {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeLot(raw: any, itemId: string, idx: number): NormalizedLot {
  const { upgrade, quality } = parseAdditional(raw?.additional ?? raw?.props ?? raw);
  const startPrice = toNum(raw?.startPrice ?? raw?.start_price ?? raw?.price ?? 0);
  const buyoutPrice = toNum(raw?.buyoutPrice ?? raw?.buyout_price ?? raw?.buyPrice ?? raw?.price ?? 0);
  const amount = toNum(raw?.amount ?? raw?.count ?? raw?.quantity ?? 1) || 1;
  const endTime = toStr(raw?.endTime ?? raw?.end_time ?? raw?.expiresAt ?? raw?.expires_at);
  const startTime = toStr(raw?.startTime ?? raw?.start_time ?? raw?.createdAt ?? raw?.created_at);
  // ВАЖНО: стабильный id, иначе трекер будет спамить «новыми» лотами при каждой проверке
  const rawId = raw?.id ?? raw?.lotId ?? raw?.uuid;
  const id =
    rawId !== undefined && rawId !== null && String(rawId) !== ""
      ? String(rawId)
      : `lot-${stableHash(`${itemId}|${startTime}|${endTime}|${startPrice}|${buyoutPrice}|${amount}|${upgrade}|${quality}`)}`;
  return { id, itemId, startPrice, buyoutPrice, amount, endTime, startTime, upgrade, quality };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeHistory(raw: any, idx: number): NormalizedHistory {
  const { upgrade, quality } = parseAdditional(raw?.additional ?? raw?.props ?? raw);
  const price = toNum(raw?.price ?? raw?.cost ?? 0);
  const amount = toNum(raw?.amount ?? raw?.count ?? 1) || 1;
  const time = toStr(raw?.time ?? raw?.date ?? raw?.soldAt ?? raw?.createdAt);
  const rawId = raw?.id;
  const id =
    rawId !== undefined && rawId !== null && String(rawId) !== ""
      ? String(rawId)
      : `h-${stableHash(`${price}|${time}|${upgrade}|${quality}|${idx}`)}`;
  return { id, price, amount, time, upgrade, quality };
}

async function eapiFetch<T>(path: string, retry = true): Promise<T> {
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch(`https://eapi.stalcraft.net${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ExboApiError("Официальный аукцион EXBO не ответил", 504);
  }
  if (res.status === 401 && retry) {
    await getAccessToken(true);
    return eapiFetch<T>(path, false);
  }
  if (!res.ok) {
    throw new ExboApiError(`EXBO не вернул аукцион (HTTP ${res.status})`, res.status === 429 ? 429 : 502);
  }
  return (await res.json()) as T;
}

export async function fetchLots(
  itemId: string,
  regionRaw: string,
  limit = 100,
  offset = 0
): Promise<{ lots: NormalizedLot[]; total: number }> {
  const region = normalizeRegion(regionRaw);
  const id = itemId.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new ExboApiError("Некорректный ID предмета", 400);
  limit = Math.min(Math.max(1, Math.floor(limit)), 100);
  offset = Math.max(0, Math.floor(offset));
  const d = await eapiFetch<{ lots?: unknown[]; total?: number }>(
    `/${region}/auction/${encodeURIComponent(id)}/lots?limit=${limit}&offset=${offset}&additional=true`,
  );
  if (!Array.isArray(d.lots)) throw new ExboApiError("EXBO изменил формат списка лотов", 502);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lots = d.lots.map((x, i) => normalizeLot(x as any, id, i + offset));
  return { lots, total: Number(d.total ?? lots.length) || lots.length };
}

export async function fetchHistory(
  itemId: string,
  regionRaw: string,
  limit = 100,
  offset = 0
): Promise<{ history: NormalizedHistory[]; total: number }> {
  const region = normalizeRegion(regionRaw);
  const id = itemId.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new ExboApiError("Некорректный ID предмета", 400);
  limit = Math.min(Math.max(1, Math.floor(limit)), 100);
  offset = Math.max(0, Math.floor(offset));
  const d = await eapiFetch<{ prices?: unknown[]; total?: number }>(
    `/${region}/auction/${encodeURIComponent(id)}/history?limit=${limit}&offset=${offset}&additional=true`,
  );
  if (!Array.isArray(d.prices)) throw new ExboApiError("EXBO изменил формат истории", 502);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const history = d.prices.map((x, i) => normalizeHistory(x as any, i + offset));
  return { history, total: Number(d.total ?? history.length) || history.length };
}

// ---------- Словарь предметов ----------

interface ListingEntry {
  data?: string;
  icon?: string;
  category?: string;
  color?: string;
  name?: { lines?: { ru?: string; en?: string } };
}

// Нормализуем категорию, чтобы в каталоге были понятные разделы:
// детекторы/устройства (Пионер, САК, Эльбрус) выносятся из «оружия» в «Устройства»,
// броня едина, патроны едины, модули — в обвесы.
function normalizeCategory(parts: string[]): string {
  const seg = parts.map((p) => p.toLowerCase());
  const first: string = seg[0] || "other";
  if (first !== "items") return first;
  const cats = seg.slice(1, -1); // например ["weapon","device"]
  if (cats.length === 0) return "other";
  if (cats.includes("device") || cats.includes("detector")) return "device";
  if (cats.includes("artefact") || cats.includes("artifact")) return "artefact";
  if (cats[0] === "weapon_modules") return "attachment";
  if (cats[0] === "armor" || cats[0] === "armour") return "armor";
  if (cats[0] === "ammo" || cats[0] === "bullet") return "ammo";
  return cats[0];
}

function entryToItem(e: ListingEntry) {
  const dataPath: string = e.data || "";
  const file = dataPath.split("/").pop() || "";
  const id = file.replace(/\.json$/i, "").toLowerCase();
  if (!id) return null;
  const nameRu = e.name?.lines?.ru || id;
  const nameEn = e.name?.lines?.en || "";
  const parts = dataPath.split("/").filter(Boolean);
  const category = normalizeCategory(parts.length >= 3 ? parts : ["items", "other", file]);
  const sub =
    parts.length >= 4 ? parts[2] : null; // подраздел (например "device" для weapon/device)
  const iconUrl = e.icon ? `${DB_BASE}${e.icon}` : `${DB_BASE}/icons/other/${id}.png`;
  return {
    id,
    nameRu,
    nameEn,
    category,
    subcategory: sub,
    iconUrl,
    color: e.color || null,
    dataPath,
    searchText: `${nameRu} ${nameEn} ${id}`.toLowerCase(),
  };
}

export async function syncItemsFromGithub(): Promise<{ count: number }> {
  // На свежей базе таблиц может не быть — создаём перед вставкой
  const { ensureSchema } = await import("./ensure-schema");
  await ensureSchema();

  // У listing.json есть запас по времени: холодный Neon + скачивание мегабайтов
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 90000);
  let listing: ListingEntry[];
  try {
    const res = await fetch(`${DB_BASE}/listing.json`, {
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`listing.json fetch failed: ${res.status}`);
    listing = (await res.json()) as ListingEntry[];
  } finally {
    clearTimeout(timeout);
  }
  const mapped = listing
    .map(entryToItem)
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Батч-вставка чанками по 250 — спокойнее для бесплатного Neon
  const chunk = 250;
  for (let i = 0; i < mapped.length; i += chunk) {
    const slice = mapped.slice(i, i + chunk);
    await db
      .insert(items)
      .values(slice)
      .onConflictDoUpdate({
        target: items.id,
        set: {
          nameRu: sql`excluded.name_ru`,
          nameEn: sql`excluded.name_en`,
          category: sql`excluded.category`,
          subcategory: sql`excluded.subcategory`,
          iconUrl: sql`excluded.icon_url`,
          color: sql`excluded.color`,
          dataPath: sql`excluded.data_path`,
          searchText: sql`excluded.search_text`,
          updatedAt: sql`now()`,
        },
      });
  }
  return { count: mapped.length };
}

export async function ensureItemsSeeded(): Promise<number> {
  // Если таблицы нет (свежий Neon) — count упадёт: создаём схему и пробуем снова,
  // а не возвращаем молча ноль
  const both = async () =>
    syncItemsFromGithub().then((r) => r.count);

  // Проверка: изменился ли формат категорий (старое "weapon/device" -> "device").
  // Если да — переиндексируем один раз, чтобы разделы в каталоге были правильными.
  const needsRecat = async (): Promise<boolean> => {
    try {
      const res = await db.execute(
        sql`select count(*)::int as c from items where category like '%/%'`
      );
      return Number((res.rows[0] as { c: number })?.c || 0) > 50;
    } catch {
      return false;
    }
  };

  try {
    const cnt = await db.execute(sql`select count(*)::int as c from items`);
    const c = Number((cnt.rows[0] as { c: number })?.c || 0);
    if (c > 100) {
      if (await needsRecat()) return both();
      return c;
    }
    return both();
  } catch (e) {
    console.error("ensureItemsSeeded (first try) failed:", e);
  }
  try {
    const { ensureSchema } = await import("./ensure-schema");
    await ensureSchema();
    const cnt = await db.execute(sql`select count(*)::int as c from items`);
    const c = Number((cnt.rows[0] as { c: number })?.c || 0);
    if (c > 100) {
      if (await needsRecat()) return both();
      return c;
    }
    return both();
  } catch (e) {
    console.error("ensureItemsSeeded (retry) failed:", e);
    return 0;
  }
}
