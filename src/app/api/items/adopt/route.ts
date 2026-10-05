import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { items } from "@/db/schema";
import { sql } from "drizzle-orm";
import { fetchLots } from "@/lib/exbo";
import { ensureSchema } from "@/lib/ensure-schema";
import { isAdmin } from "@/lib/identity";
import { FALLBACK_ICON } from "@/lib/utils";
import { invalidateCatalog } from "@/lib/catalog";

export const dynamic = "force-dynamic";

/**
 * Ручное добавление предмета, которого нет в справочнике EXBO.
 *
 * Часть предметов торгуется на аукционе, но отсутствует в listing.json
 * (например «Боевой набор»). Админ вводит ID и название — предмет попадает
 * в каталог и становится доступен для трекеров всем пользователям.
 *
 * Существующие трекеры при этом не затрагиваются: они хранят название
 * и иконку у себя и не ссылаются на таблицу items.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) {
    return NextResponse.json({ success: false, error: "admin_only" }, { status: 403 });
  }
  try {
    await ensureSchema();
    const body = (await req.json()) as {
      id?: string;
      nameRu?: string;
      category?: string;
      iconUrl?: string;
    };

    const id = String(body.id || "").trim().toLowerCase();
    if (!/^[a-z0-9]{3,12}$/.test(id)) {
      return NextResponse.json(
        { success: false, error: "bad_id", message: "ID должен состоять из 3–12 латинских букв и цифр." },
        { status: 400 },
      );
    }

    // Проверяем, что предмет реально существует на аукционе
    const regions = ["EU", "RU", "NA"];
    let foundRegion: string | null = null;
    let lotsTotal = 0;
    for (const region of regions) {
      try {
        const { total } = await fetchLots(id, region, 1, 0);
        if (total > 0) {
          foundRegion = region;
          lotsTotal = total;
          break;
        }
      } catch {
        // регион недоступен — пробуем следующий
      }
    }

    const nameRu = String(body.nameRu || "").trim() || id.toUpperCase();
    const category = String(body.category || "other").trim() || "other";
    const iconUrl = String(body.iconUrl || "").trim() || FALLBACK_ICON;

    await db
      .insert(items)
      .values({
        id,
        nameRu,
        nameEn: nameRu,
        category,
        subcategory: null,
        iconUrl,
        color: null,
        dataPath: null,
        searchText: `${nameRu} ${id}`.toLowerCase(),
      })
      .onConflictDoUpdate({
        target: items.id,
        set: {
          nameRu: sql`excluded.name_ru`,
          category: sql`excluded.category`,
          iconUrl: sql`excluded.icon_url`,
          searchText: sql`excluded.search_text`,
          updatedAt: sql`now()`,
        },
      });

    invalidateCatalog();

    return NextResponse.json({
      success: true,
      id,
      nameRu,
      foundOnAuction: !!foundRegion,
      region: foundRegion,
      lotsTotal,
      message: foundRegion
        ? `Предмет добавлен. На аукционе ${foundRegion} сейчас ${lotsTotal} лот(ов).`
        : "Предмет добавлен, но лотов на аукционе сейчас нет. Проверьте ID, если поиск ничего не найдёт.",
    });
  } catch (e) {
    console.error("POST /api/items/adopt failed:", e);
    return NextResponse.json({ success: false, error: "adopt_failed" }, { status: 500 });
  }
}
