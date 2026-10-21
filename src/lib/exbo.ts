import { db } from "@/db";
import { items } from "@/db/schema";
import { sql } from "drizzle-orm";
import { DB_BASE } from "./constants";
import { normalizeLot, normalizeHistory, type NormalizedLot, type NormalizedHistory } from "./auction-data";
import { boundedInt } from "./validation";
export type { NormalizedLot, NormalizedHistory } from "./auction-data";

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
// Блокировка параллельных запросов токена: без неё 5 одновременных вызовов
// делали 5 одинаковых POST на exbo.net. Теперь ждёт один общий промис.
let tokenPromise: Promise<string> | null = null;

export async function getAccessToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (tokenPromise) return tokenPromise;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new ExboApiError("На сервере не заданы EXBO_CLIENT_ID/EXBO_CLIENT_SECRET", 503);
  }
  tokenPromise = (async () => {
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
    tokenExpiresAt = Date.now() + Math.max(1000, (data.expires_in || 3600) * 900);
    return cachedToken as string;
  })();
  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

export function normalizeRegion(r: string | null | undefined): string {
  const v = (r || "EU").toUpperCase();
  if (v === "RU" || v === "EU" || v === "NA") return v;
  return "EU";
}

async function eapiFetch<T>(path: string, retry = true): Promise<T> {
  const token = await getAccessToken();
  let res: Response;
  try {
    res = await fetch(`${(process.env.EXBO_API_BASE_URL || "https://eapi.stalzone.com").replace(/\/$/, "")}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ExboApiError("Официальный аукцион EXBO не ответил", 504);
  }
  if (res.status === 401 && retry) {
    if (cachedToken === token) await getAccessToken(true);
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
  limit = boundedInt(limit, 100, 1, 100);
  offset = boundedInt(offset, 0, 0, 100_000);
  const d = await eapiFetch<{ lots?: unknown[]; total?: number }>(
    `/${region}/auction/${encodeURIComponent(id)}/lots?limit=${limit}&offset=${offset}&additional=true`,
  );
  if (!Array.isArray(d.lots)) throw new ExboApiError("EXBO изменил формат списка лотов", 502);
   
  const lots = d.lots.map((x) => normalizeLot(x, id));
  return { lots, total: boundedInt(d.total, lots.length, lots.length, Number.MAX_SAFE_INTEGER) };
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
  limit = boundedInt(limit, 100, 1, 100);
  offset = boundedInt(offset, 0, 0, 100_000);
  const d = await eapiFetch<{ prices?: unknown[]; total?: number }>(
    `/${region}/auction/${encodeURIComponent(id)}/history?limit=${limit}&offset=${offset}&additional=true`,
  );
  if (!Array.isArray(d.prices)) throw new ExboApiError("EXBO изменил формат истории", 502);
   
  const history = d.prices.map((x, i) => normalizeHistory(x, i + offset));
  return { history, total: boundedInt(d.total, history.length, history.length, Number.MAX_SAFE_INTEGER) };
}

// Сначала узнаём размер выдачи. Для маленького аукциона нужен один запрос,
// а не три. Остальные страницы загружаем ограниченными пачками.
const PAGE_SIZE = 100;
const PAGE_CONCURRENCY = 3;

async function collectPages<T>(
  need: number,
  fetchPage: (limit: number, offset: number) => Promise<{ rows: T[]; total: number }>,
): Promise<{ rows: T[]; total: number }> {
  const capped = boundedInt(need, 500, 1, 2000);
  const first = await fetchPage(Math.min(capped, PAGE_SIZE), 0);
  const rows = [...first.rows];
  let total = first.total;
  const offsets: number[] = [];
  for (let off = PAGE_SIZE; off < Math.min(capped, total); off += PAGE_SIZE) offsets.push(off);
  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const batch = await Promise.all(offsets.slice(i, i + PAGE_CONCURRENCY).map((off) =>
      fetchPage(Math.min(PAGE_SIZE, capped - off), off),
    ));
    for (const page of batch) {
      rows.push(...page.rows);
      total = Math.max(total, page.total);
    }
  }
  return { rows: rows.slice(0, capped), total };
}

export async function fetchLotsAll(itemId: string, region: string, need = 500) {
  const result = await collectPages(need, async (limit, offset) => {
    const page = await fetchLots(itemId, region, limit, offset);
    return { rows: page.lots, total: page.total };
  });
  const lots = [...new Map(result.rows.map((lot) => [lot.id, lot])).values()];
  return { lots, total: result.total, complete: lots.length >= result.total };
}

export async function fetchHistoryAll(itemId: string, region: string, need = 400) {
  const result = await collectPages(need, async (limit, offset) => {
    const page = await fetchHistory(itemId, region, limit, offset);
    return { rows: page.history, total: page.total };
  });
  const history = [...new Map(result.rows.map((entry) => [entry.id, entry])).values()];
  history.sort((a, b) => (b.time ? Date.parse(b.time) : 0) - (a.time ? Date.parse(a.time) : 0));
  return { history, total: result.total, complete: history.length >= result.total };
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
  const id = file.replace(/\.json$/i, "");
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

/** Скачивает listing.json конкретной базы (global или регион вроде ru) */
async function fetchListing(base: string): Promise<ListingEntry[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(`${base}/listing.json`, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) return [];
    return (await res.json()) as ListingEntry[];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Обходит дерево репозитория EXBO и возвращает предметы, которых нет в listing.json.
 *
 * Зачем: listing.json — неполный индекс. Например, в global он содержит 2329
 * записей, тогда как реальных предметов в репозитории больше. Из-за этого
 * часть предметов (в том числе продающихся на аукционе) не попадала в каталог.
 */
async function fetchMissingFromTree(knownPaths: Set<string>): Promise<ListingEntry[]> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60000);
  let tree: { path: string; type: string }[];
  try {
    const res = await fetch(
      "https://api.github.com/repos/EXBO-Studio/stalzone-database/git/trees/main?recursive=1",
      { cache: "no-store", signal: ctrl.signal, headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { tree?: { path: string; type: string }[] };
    tree = json.tree || [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }

  // Только файлы предметов; варианты заточки (_variants) — это не отдельные предметы
  const candidates = tree
    .filter((n) => n.type === "blob")
    .map((n) => n.path)
    .filter((p) => p.startsWith("global/items/") && p.endsWith(".json") && !p.includes("/_variants/"))
    .filter((p) => !knownPaths.has(p.replace(/^global/, "")));

  if (candidates.length === 0) return [];

  // Тянем параллельно небольшими порциями, чтобы не упереться в лимиты GitHub
  const found: ListingEntry[] = [];
  const BATCH = 25;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          const res = await fetch(`${DB_BASE}${path.replace(/^global/, "")}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) return null;
          const raw = (await res.json()) as {
            name?: { lines?: { ru?: string; en?: string } };
            color?: string;
          };
          if (!raw?.name?.lines?.ru) return null;
          const rel = path.replace(/^global/, "");
          return {
            data: rel,
            icon: rel.replace("/items/", "/icons/").replace(/\.json$/, ".png"),
            color: raw.color,
            name: raw.name,
          } as ListingEntry;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) found.push(r);
  }
  return found;
}

export async function syncItemsFromGithub(): Promise<{ count: number; extra: number }> {
  // На свежей базе таблиц может не быть — создаём перед вставкой
  const { ensureSchema } = await import("./ensure-schema");
  await ensureSchema();

  // 1. Глобальный список — основа каталога
  const listing = await fetchListing(DB_BASE);
  if (listing.length === 0) throw new Error("listing.json fetch failed");

  // 2. Региональный список: в нём встречаются предметы, которых нет в global
  const RU_BASE = DB_BASE.replace(/\/global$/, "/ru");
  const ruListing = RU_BASE !== DB_BASE ? await fetchListing(RU_BASE) : [];

  const byPath = new Map<string, ListingEntry>();
  for (const entry of [...listing, ...ruListing]) {
    if (entry?.data) byPath.set(entry.data, entry);
  }
  const fromListings = byPath.size;

  // 3. Добираем предметы, которых нет ни в одном listing.json
  const missing = await fetchMissingFromTree(new Set(byPath.keys()));
  for (const entry of missing) {
    if (entry.data) byPath.set(entry.data, entry);
  }

  const mapped = [...byPath.values()]
    .map(entryToItem)
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const extra = Math.max(0, mapped.length - fromListings);

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
  // ВАЖНО: только добавляем и обновляем. Ничего не удаляем — трекеры
  // пользователей хранят название и иконку у себя и не зависят от этой таблицы.
  console.log(`Items sync: ${mapped.length} предметов (сверх listing.json: ${extra})`);
  return { count: mapped.length, extra };
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
