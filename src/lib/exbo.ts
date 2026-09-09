import { db } from "@/db";
import { items } from "@/db/schema";
import { sql } from "drizzle-orm";
import { DB_BASE } from "./constants";

// Ключи читаются из env (прокинуты из .env). Значения по умолчанию —
// те, что прислал пользователь, чтобы приложение работало из коробки.
const CLIENT_ID = process.env.EXBO_CLIENT_ID || "4062";
const CLIENT_SECRET =
  process.env.EXBO_CLIENT_SECRET || "bcoEmyJYSCDarPliHZ0SNOkZscVDCkP0twxPwfLU";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export async function getAccessToken(force = false): Promise<string | null> {
  if (!force && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "",
    });
    const res = await fetch("https://exbo.net/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("EXBO token error:", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) return null;
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + (data.expires_in ? data.expires_in * 1000 - 60000 : 3600000);
    return cachedToken;
  } catch (e) {
    console.error("EXBO token fetch failed:", e);
    return null;
  }
}

export function normalizeRegion(r: string | null | undefined): string {
  const v = (r || "RU").toUpperCase();
  if (v === "RU" || v === "EU" || v === "NA") return v;
  return "RU";
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

export type LotSort = "buyout_price" | "time_left" | "time_created" | "current_price";
export type SortOrder = "asc" | "desc";

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

// ---------- Короткоживущий кэш ответов EAPI ----------
// Планировщик + открытые вкладки + внешний cron часто спрашивают одни и те
// же лоты почти одновременно — кэш на несколько секунд убирает дублирующие
// запросы к EAPI и держит сайт быстрым даже при нескольких пользователях.
const RESPONSE_CACHE_TTL_MS = 8000;
const responseCache = new Map<string, { at: number; data: unknown }>();

function cacheGet(key: string): unknown | undefined {
  const hit = responseCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > RESPONSE_CACHE_TTL_MS) {
    responseCache.delete(key);
    return undefined;
  }
  return hit.data;
}

function cacheSet(key: string, data: unknown) {
  responseCache.set(key, { at: Date.now(), data });
  // не даём карте расти бесконечно
  if (responseCache.size > 500) {
    const oldestKey = responseCache.keys().next().value;
    if (oldestKey) responseCache.delete(oldestKey);
  }
}

async function eapiFetch(
  path: string,
  retry = true
): Promise<{ ok: boolean; data: unknown; status: number }> {
  const cached = cacheGet(path);
  if (cached !== undefined) return { ok: true, data: cached, status: 200 };

  const token = await getAccessToken();
  if (!token) return { ok: false, data: null, status: 401 };
  try {
    const res = await fetch(`https://eapi.stalcraft.net${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (res.status === 401 && retry) {
      const t2 = await getAccessToken(true);
      if (!t2) return { ok: false, data: null, status: 401 };
      const res2 = await fetch(`https://eapi.stalcraft.net${path}`, {
        headers: { Authorization: `Bearer ${t2}` },
        cache: "no-store",
      });
      if (!res2.ok) return { ok: false, data: null, status: res2.status };
      const json2 = await res2.json();
      cacheSet(path, json2);
      return { ok: true, data: json2, status: 200 };
    }
    if (!res.ok) return { ok: false, data: null, status: res.status };
    const json = await res.json();
    cacheSet(path, json);
    return { ok: true, data: json, status: 200 };
  } catch (e) {
    console.error("EAPI fetch failed:", path, e);
    return { ok: false, data: null, status: 500 };
  }
}

function lotsPath(
  region: string,
  id: string,
  limit: number,
  offset: number,
  sort?: LotSort,
  order?: SortOrder
): string {
  let p = `/${region}/auction/${id}/lots?limit=${limit}&offset=${offset}&additional=true`;
  if (sort) p += `&sort=${sort}`;
  if (order) p += `&order=${order}`;
  return p;
}

export async function fetchLots(
  itemId: string,
  regionRaw: string,
  limit = 100,
  offset = 0,
  sort?: LotSort,
  order?: SortOrder
): Promise<{ lots: NormalizedLot[]; total: number }> {
  const region = normalizeRegion(regionRaw);
  const id = itemId.toLowerCase();
  // EAPI отклоняет limit > 200 (HTTP 400) — держим безопасный максимум 100
  limit = Math.min(Math.max(1, limit), 100);
  const r = await eapiFetch(lotsPath(region, id, limit, offset, sort, order));
  if (r.ok) {
    const d = r.data as { lots?: unknown[]; items?: unknown[]; total?: number };
    const arr = Array.isArray(d?.lots)
      ? d.lots
      : Array.isArray(d?.items)
        ? d.items
        : Array.isArray(d)
          ? (d as unknown[])
          : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lots = arr.map((x, i) => normalizeLot(x as any, id, i + offset));
    return { lots, total: Number(d?.total ?? lots.length) || lots.length };
  }
  return { lots: [], total: 0 };
}

// Параллельно тянет несколько страниц лотов (быстрее в разы, чем по одной).
export async function fetchLotsPages(
  itemId: string,
  region: string,
  pages: number,
  sort?: LotSort,
  order?: SortOrder,
  pageSize = 100
): Promise<{ lots: NormalizedLot[]; total: number }> {
  const offsets = Array.from({ length: Math.max(1, pages) }, (_, i) => i * pageSize);
  const results = await Promise.all(
    offsets.map((off) => fetchLots(itemId, region, pageSize, off, sort, order))
  );
  const seen = new Set<string>();
  const lots: NormalizedLot[] = [];
  let total = 0;
  for (const r of results) {
    total = Math.max(total, r.total);
    for (const l of r.lots) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      lots.push(l);
    }
  }
  return { lots, total };
}

export interface LotExtremes {
  total: number;
  min: NormalizedLot | null;
  max: NormalizedLot | null;
}

// Точные минимум/максимум по цене за лот — 2 лёгких запроса вместо перебора
// сотен страниц. Так самый дорогой лот никогда не "теряется" при пагинации.
export async function fetchLotExtremes(itemId: string, regionRaw: string): Promise<LotExtremes> {
  const region = normalizeRegion(regionRaw);
  const id = itemId.toLowerCase();
  const [asc, desc] = await Promise.all([
    fetchLots(id, region, 1, 0, "buyout_price", "asc"),
    fetchLots(id, region, 1, 0, "buyout_price", "desc"),
  ]);
  return {
    total: Math.max(asc.total, desc.total),
    min: asc.lots[0] || null,
    max: desc.lots[0] || null,
  };
}

function historyPath(region: string, id: string, limit: number, offset: number): string {
  return `/${region}/auction/${id}/history?limit=${limit}&offset=${offset}&additional=true`;
}

export async function fetchHistory(
  itemId: string,
  regionRaw: string,
  limit = 200,
  offset = 0
): Promise<{ history: NormalizedHistory[]; total: number }> {
  const region = normalizeRegion(regionRaw);
  const id = itemId.toLowerCase();
  // EAPI отклоняет большие limit (HTTP 400) — держим безопасный максимум 100
  limit = Math.min(Math.max(1, limit), 100);
  const r = await eapiFetch(historyPath(region, id, limit, offset));
  if (r.ok) {
    const d = r.data as {
      prices?: unknown[];
      history?: unknown[];
      items?: unknown[];
      total?: number;
    };
    const arr = Array.isArray(d?.prices)
      ? d.prices
      : Array.isArray(d?.history)
        ? d.history
        : Array.isArray(d?.items)
          ? d.items
          : Array.isArray(d)
            ? (d as unknown[])
            : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const history = arr.map((x, i) => normalizeHistory(x as any, i + offset));
    return { history, total: Number(d?.total ?? history.length) || history.length };
  }
  return { history: [], total: 0 };
}

// Параллельная постраничная догрузка истории продаж (EAPI сортирует её
// только по времени — от новых к старым, сортировку по цене API не поддерживает).
export async function fetchHistoryPages(
  itemId: string,
  region: string,
  pages: number,
  pageSize = 100
): Promise<{ history: NormalizedHistory[]; total: number }> {
  const offsets = Array.from({ length: Math.max(1, pages) }, (_, i) => i * pageSize);
  const results = await Promise.all(
    offsets.map((off) => fetchHistory(itemId, region, pageSize, off))
  );
  const seen = new Set<string>();
  const history: NormalizedHistory[] = [];
  let total = 0;
  for (const r of results) {
    total = Math.max(total, r.total);
    for (const h of r.history) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      history.push(h);
    }
  }
  history.sort((a, b) => {
    const ta = a.time ? new Date(a.time).getTime() : 0;
    const tb = b.time ? new Date(b.time).getTime() : 0;
    return tb - ta;
  });
  return { history, total };
}

// ---------- Словарь предметов ----------

interface ListingEntry {
  data?: string;
  icon?: string;
  category?: string;
  color?: string;
  name?: { lines?: { ru?: string; en?: string } };
}

function entryToItem(e: ListingEntry) {
  const dataPath: string = e.data || "";
  const file = dataPath.split("/").pop() || "";
  const id = file.replace(/\.json$/i, "").toLowerCase();
  if (!id) return null;
  const nameRu = e.name?.lines?.ru || id;
  const nameEn = e.name?.lines?.en || "";
  // категория: /items/weapon/pistol/xxxx.json -> weapon/pistol
  const parts = dataPath.split("/").filter(Boolean);
  let category = "other";
  if (parts[0] === "items" && parts.length >= 3) {
    category = parts.slice(1, -1).join("/");
  } else if (e.category) {
    category = e.category;
  }
  const iconUrl = e.icon ? `${DB_BASE}${e.icon}` : `${DB_BASE}/icons/other/${id}.png`;
  return {
    id,
    nameRu,
    nameEn,
    category,
    subcategory: category.split("/")[1] || null,
    iconUrl,
    color: e.color || null,
    dataPath,
    searchText: `${nameRu} ${nameEn} ${id}`.toLowerCase(),
  };
}

export async function syncItemsFromGithub(): Promise<{ count: number }> {
  const res = await fetch(`${DB_BASE}/listing.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`listing.json fetch failed: ${res.status}`);
  const listing = (await res.json()) as ListingEntry[];
  const mapped = listing
    .map(entryToItem)
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Батч-вставка чанками по 500
  const chunk = 500;
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

let seededChecked = false;
let indexesEnsured = false;

// Индексы для мгновенного поиска по ~2300 предметам даже при вводе каждой
// буквы (триграммы через pg_trgm вместо полного скана таблицы на ILIKE).
async function ensureSearchIndexes() {
  if (indexesEnsured) return;
  indexesEnsured = true;
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS items_search_trgm_idx ON items USING gin (search_text gin_trgm_ops)`
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS items_name_trgm_idx ON items USING gin (name_ru gin_trgm_ops)`
    );
    await db.execute(sql`CREATE INDEX IF NOT EXISTS items_category_idx ON items (category)`);
  } catch (e) {
    // На некоторых бесплатных хостингах расширение может быть недоступно —
    // тогда просто продолжаем работать без ускоренного индекса.
    console.warn("ensureSearchIndexes: pg_trgm недоступен, поиск будет чуть медленнее:", e);
  }
}

export async function ensureItemsSeeded(): Promise<number> {
  // После первой успешной проверки за жизнь процесса больше не бьём базу
  // счётчиком на каждый чих — база предметов пополняется отдельным
  // фоновым синком (см. lib/scheduler.ts), а не на каждый HTTP-запрос.
  if (seededChecked) return -1;
  const cnt = await db.execute(sql`select count(*)::int as c from items`);
  const c = Number((cnt.rows[0] as { c: number })?.c || 0);
  if (c > 100) {
    seededChecked = true;
    void ensureSearchIndexes();
    return c;
  }
  try {
    const r = await syncItemsFromGithub();
    seededChecked = true;
    void ensureSearchIndexes();
    return r.count;
  } catch (e) {
    console.error("ensureItemsSeeded failed:", e);
    return c;
  }
}
