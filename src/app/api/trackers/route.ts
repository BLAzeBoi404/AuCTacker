import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { trackers } from "@/db/schema";
import { desc } from "drizzle-orm";
import { normalizeRegion } from "@/lib/exbo";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db.select().from(trackers).orderBy(desc(trackers.createdAt));
    return NextResponse.json({ success: true, trackers: rows });
  } catch (e) {
    console.error("GET /api/trackers failed:", e);
    return NextResponse.json({ success: false, trackers: [] });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const itemId = String(body.itemId || "").toLowerCase().trim();
    if (!itemId) {
      return NextResponse.json({ success: false, error: "itemId_required" }, { status: 400 });
    }
    const [row] = await db
      .insert(trackers)
      .values({
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
        enableSound: body.enableSound ?? true,
        enableBrowser: body.enableBrowser ?? true,
        notifyChatIds: Array.isArray(body.notifyChatIds)
          ? body.notifyChatIds.map(String).slice(0, 20)
          : [],
      })
      .returning();
    return NextResponse.json({ success: true, tracker: row });
  } catch (e) {
    console.error("POST /api/trackers failed:", e);
    return NextResponse.json({ success: false, error: "create_failed" }, { status: 500 });
  }
}
