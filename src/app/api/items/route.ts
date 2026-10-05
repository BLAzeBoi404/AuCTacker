import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { items } from "@/db/schema";
import { fetchLots } from "@/lib/exbo";
import { FALLBACK_ICON } from "@/lib/utils";
import { searchCatalog, addToCatalog, type CatalogItem } from "@/lib/catalog";

export const dynamic = "force-dynamic";

/**
 * Добавляет предмет, которого нет в справочнике EXBO, но который торгуется.
 * Проверяем ID по регионам: если аукцион отдаёт лоты — предмет реальный.
 */
async function tryAdoptUnlistedItem(id: string): Promise<CatalogItem | null> {
  for (const region of ["EU", "RU", "NA"]) {
    try {
      const { total } = await fetchLots(id, region, 1, 0);
      if (total === 0) continue;

      const row: CatalogItem = {
        id,
        nameRu: id.toUpperCase(),
        nameEn: id.toUpperCase(),
        category: "other",
        subcategory: null,
        iconUrl: FALLBACK_ICON,
        color: null,
        dataPath: null,
        search: id.toLowerCase(),
      };
      await db
        .insert(items)
        .values({
          id: row.id,
          nameRu: row.nameRu,
          nameEn: row.nameEn,
          category: row.category,
          subcategory: row.subcategory,
          iconUrl: row.iconUrl,
          color: row.color,
          dataPath: row.dataPath,
          searchText: row.search,
        })
        .onConflictDoNothing();
      addToCatalog(row);
      console.log(`Adopted unlisted item ${id} (found on ${region} auction)`);
      return row;
    } catch {
      // регион недоступен — пробуем следующий
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const category = (searchParams.get("category") || "").trim();
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 30)));
    const offset = Math.max(0, Number(searchParams.get("offset") || 0));

    // Поиск идёт из памяти — база не просыпается
    const found = await searchCatalog(q, category, limit, offset);

    // Предмета нет в справочнике, но пользователь ввёл ID:
    // часть предметов EXBO не публикует, хотя они торгуются на аукционе.
    if (found.total === 0 && /^[a-z0-9]{3,12}$/i.test(q)) {
      const adopted = await tryAdoptUnlistedItem(q.toLowerCase());
      if (adopted) {
        return NextResponse.json({
          success: true,
          items: [adopted],
          total: 1,
          categories: found.categories,
          needsSync: false,
          adopted: true,
        });
      }
    }

    return NextResponse.json({
      success: true,
      items: found.items,
      total: found.total,
      categories: found.categories,
      needsSync: found.total === 0 && !q && !category,
    });
  } catch (e) {
    console.error("GET /api/items failed:", e);
    return NextResponse.json({ success: false, items: [], total: 0, error: "items_failed" });
  }
}
