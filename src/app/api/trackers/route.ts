import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { trackers } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { normalizeRegion } from "@/lib/exbo";
import { getOwnerKey } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";

export const dynamic = "force-dynamic";

// Максимум трекеров на один профиль — защита от переполнения общей базы
const MAX_TRACKERS_PER_USER = 25;

export async function GET() {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const rows = await db
      .select()
      .from(trackers)
      .where(eq(trackers.ownerKey, owner))
      .orderBy(desc(trackers.createdAt));
    return NextResponse.json({ success: true, trackers: rows });
  } catch (e) {
    console.error("GET /api/trackers failed:", e);
    return NextResponse.json({ success: false, trackers: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const body = await req.json();
    const itemId = String(body.itemId || "").toLowerCase().trim();
    if (!itemId) {
      return NextResponse.json({ success: false, error: "itemId_required" }, { status: 400 });
    }

    const mine = await db
      .select({ id: trackers.id })
      .from(trackers)
      .where(eq(trackers.ownerKey, owner));
    if (mine.length >= MAX_TRACKERS_PER_USER) {
      return NextResponse.json(
        { success: false, error: "limit_reached", message: `Максимум ${MAX_TRACKERS_PER_USER} трекеров на профиль. Удалите ненужные.` },
        { status: 400 }
      );
    }

    const [row] = await db
      .insert(trackers)
      .values({
        ownerKey: owner,
        itemId,
        itemName: String(body.itemName || itemId),
        itemIcon: body.itemIcon ? String(body.itemIcon) : null,
        region: normalizeRegion(body.region),
        upgradeMode: ["exact", "min", "any"].includes(body.upgradeMode) ? body.upgradeMode : "exact",
        targetUpgrade: Math.max(0, Math.min(30, Number(body.targetUpgrade) || 0)),
        targetQuality: [-1, 0, 1, 2, 3, 4, 5].includes(Number(body.targetQuality))
          ? Number(body.targetQuality)
          : -1,
        maxPrice: Math.max(0, Number(body.maxPrice) || 0),
        minPrice: Math.max(0, Number(body.minPrice) || 0),
        enabled: body.enabled ?? true,
        enableSound: false,
        enableBrowser: false,
        notifyChatIds: [],
      })
      .returning();
    return NextResponse.json({ success: true, tracker: row });
  } catch (e) {
    console.error("POST /api/trackers failed:", e);
    return NextResponse.json({ success: false, error: "create_failed" }, { status: 500 });
  }
}
