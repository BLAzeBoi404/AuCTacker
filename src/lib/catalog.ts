import { db } from "@/db";
import { sql } from "drizzle-orm";
import { normalizeSearch, searchRank } from "./search";
import { ensureSchema } from "./ensure-schema";
import { ensureItemsSeeded } from "./exbo";

/**
 * КЭШ КАТАЛОГА ПРЕДМЕТОВ.
 *
 * Каталог — это ~2350 строк, которые меняются только при синхронизации с GitHub.
 * Держим его целиком в памяти (примерно 1 МБ) и обслуживаем поиск без базы.
 *
 * Зачем: раньше каждый ввод буквы в поиск и каждое открытие каталога били
 * по Neon 3 запросами. Когда сайтом пользуются друзья, это будило базу
 * постоянно и сжигало бесплатные CU-часы. Теперь база нужна только
 * при первой загрузке каталога и после обновления справочника.
 */
export interface CatalogItem {
  id: string;
  nameRu: string;
  nameEn: string | null;
  category: string;
  subcategory: string | null;
  iconUrl: string | null;
  color: string | null;
  dataPath: string | null;
  search: string;
}

interface CatalogCache {
  items: CatalogItem[];
  byId: Map<string, CatalogItem>;
  categories: { category: string; count: number }[];
  loadedAt: number;
}

let cache: CatalogCache | null = null;
let loading: Promise<CatalogCache> | null = null;

/** Сбросить кэш — вызывается после синхронизации справочника */
export function invalidateCatalog(): void {
  cache = null;
}

async function load(): Promise<CatalogCache> {
  await ensureSchema();
  await ensureItemsSeeded();

  const res = await db.execute(sql`
    select id, name_ru as "nameRu", name_en as "nameEn", category,
           subcategory, icon_url as "iconUrl", color, data_path as "dataPath"
    from items
  `);

  const items = (res.rows as unknown as Omit<CatalogItem, "search">[]).map((row) => ({
    ...row,
    search: normalizeSearch(`${row.nameRu} ${row.nameEn || ""} ${row.id}`),
  }));

  const counts = new Map<string, number>();
  for (const item of items) {
    const top = (item.category || "other").split("/")[0];
    counts.set(top, (counts.get(top) || 0) + 1);
  }

  const built: CatalogCache = {
    items,
    byId: new Map(items.map((i) => [i.id, i])),
    categories: [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30),
    loadedAt: Date.now(),
  };
  cache = built;
  console.log(`Catalog cached: ${items.length} items`);
  return built;
}

async function getCache(): Promise<CatalogCache> {
  if (cache) return cache;
  if (loading) return loading;
  loading = load().finally(() => {
    loading = null;
  });
  return loading;
}

export interface SearchResult {
  items: CatalogItem[];
  total: number;
  categories: { category: string; count: number }[];
  cached: boolean;
}

/** Поиск по каталогу. Работает из памяти, базу не будит. */
export async function searchCatalog(
  query: string,
  category: string,
  limit: number,
  offset: number,
): Promise<SearchResult> {
  const wasCached = cache !== null;
  const data = await getCache();
  const q = normalizeSearch(query);
  const cat = category.trim().toLowerCase();
  const filterCat = cat && cat !== "all";

  let matched: CatalogItem[];
  if (!q && !filterCat) {
    matched = data.items;
  } else {
    matched = data.items.filter((item) => {
      if (filterCat && !item.category.toLowerCase().startsWith(cat)) return false;
      return !q || item.search.includes(q);
    });
  }

  // Точное совпадение по ID и коротким названиям — выше в списке
  if (q) {
    matched = [...matched].sort((a, b) => {
      return searchRank(a, query) - searchRank(b, query)
        || a.nameRu.length - b.nameRu.length || a.id.localeCompare(b.id);
    });
  }

  return {
    items: matched.slice(offset, offset + limit),
    total: matched.length,
    categories: data.categories,
    cached: wasCached,
  };
}

/** Предмет по ID — тоже из памяти */
export async function getCatalogItem(id: string): Promise<CatalogItem | null> {
  const data = await getCache();
  const exact = data.byId.get(id);
  if (exact) return exact;
  // Старые ссылки сохраняем только при однозначном совпадении.
  const matches = data.items.filter((item) => item.id.toLowerCase() === id.toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

/** Добавить предмет в кэш, не перечитывая всю базу */
export function addToCatalog(item: CatalogItem): void {
  if (!cache) return;
  cache.byId.set(item.id, item);
  const idx = cache.items.findIndex((i) => i.id === item.id);
  if (idx >= 0) cache.items[idx] = item;
  else cache.items.push(item);
}

export function getCatalogStatus() {
  return {
    cached: cache !== null,
    items: cache?.items.length ?? 0,
    ageSec: cache ? Math.round((Date.now() - cache.loadedAt) / 1000) : null,
  };
}
