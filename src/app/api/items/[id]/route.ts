import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { ensureItemsSeeded } from "@/lib/exbo";
import { DB_BASE } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureItemsSeeded();
    const { id } = await params;
    const itemId = id.toLowerCase();
    const res = await db.execute(sql`
      select id, name_ru as "nameRu", name_en as "nameEn", category, subcategory, icon_url as "iconUrl", color, data_path as "dataPath"
      from items where id = ${itemId} limit 1
    `);
    const row = res.rows[0] as unknown as {
      id: string;
      nameRu: string;
      nameEn: string;
      category: string;
      iconUrl: string;
    } | undefined;

    if (row) return NextResponse.json({ success: true, item: row });

    // Fallback: пробуем подтянуть напрямую из GitHub по известным путям
    // Если предмета нет в кэше — возвращаем заглушку с id
    return NextResponse.json({
      success: true,
      item: {
        id: itemId,
        nameRu: itemId,
        nameEn: "",
        category: "other",
        iconUrl: `${DB_BASE}/icons/other/${itemId}.png`,
      },
      fallback: true,
    });
  } catch (e) {
    console.error("GET /api/items/[id] failed:", e);
    return NextResponse.json({ success: false, error: "item_failed" });
  }
}
