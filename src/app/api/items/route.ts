import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { ensureItemsSeeded } from "@/lib/exbo";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await ensureItemsSeeded();
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const category = (searchParams.get("category") || "").trim();
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 30)));
    const offset = Math.max(0, Number(searchParams.get("offset") || 0));

    const qLike = `%${q.toLowerCase()}%`;
    const qRaw = `%${q}%`;
    const catLike = `${category}%`;

    const rowsRes = await db.execute(sql`
      select id, name_ru as "nameRu", name_en as "nameEn", category, subcategory, icon_url as "iconUrl", color, data_path as "dataPath"
      from items
      where (${q === ""} or search_text ilike ${qLike} or name_ru ilike ${qRaw} or id ilike ${qRaw})
        and (${category === "" || category === "all"} or category ilike ${catLike})
      order by
        case when id = ${q.toLowerCase()} then 0
             when name_ru ilike ${qRaw} then 1
             else 2 end,
        length(name_ru) asc
      limit ${limit} offset ${offset}
    `);

    const countRes = await db.execute(sql`
      select count(*)::int as c from items
      where (${q === ""} or search_text ilike ${qLike} or name_ru ilike ${qRaw} or id ilike ${qRaw})
        and (${category === "" || category === "all"} or category ilike ${catLike})
    `);
    const total = Number((countRes.rows[0] as unknown as { c: number })?.c || 0);

    let categories: { category: string; count: number }[] = [];
    try {
      const catRes = await db.execute(sql`
        select split_part(category, '/', 1) as category, count(*)::int as count
        from items group by 1 order by 2 desc limit 30
      `);
      categories = catRes.rows as unknown as typeof categories;
    } catch {
      categories = [];
    }

    return NextResponse.json({
      success: true,
      items: rowsRes.rows,
      total,
      categories,
    });
  } catch (e) {
    console.error("GET /api/items failed:", e);
    return NextResponse.json({ success: false, items: [], total: 0, error: "items_failed" });
  }
}
