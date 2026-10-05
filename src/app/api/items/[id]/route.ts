import { NextRequest, NextResponse } from "next/server";
import { getCatalogItem } from "@/lib/catalog";
import { DB_BASE } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const itemId = id.toLowerCase();

    // Из памяти — база не просыпается
    const item = await getCatalogItem(itemId);
    if (item) return NextResponse.json({ success: true, item });

    // Предмета нет в справочнике — отдаём заглушку, чтобы страница открылась
    return NextResponse.json({
      success: true,
      item: {
        id: itemId,
        nameRu: itemId.toUpperCase(),
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
