import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { trackers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getOwnerKey } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const { id } = await params;
    const body = await req.json();
    const patch: Partial<typeof trackers.$inferInsert> = {};
    if (body.itemName !== undefined) patch.itemName = String(body.itemName);
    if (body.upgradeMode !== undefined) patch.upgradeMode = body.upgradeMode;
    if (body.targetUpgrade !== undefined) patch.targetUpgrade = Number(body.targetUpgrade) || 0;
    if (body.targetQuality !== undefined) patch.targetQuality = Number(body.targetQuality);
    if (body.maxPrice !== undefined) patch.maxPrice = Math.max(0, Number(body.maxPrice) || 0);
    if (body.minPrice !== undefined) patch.minPrice = Math.max(0, Number(body.minPrice) || 0);
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body.region !== undefined) patch.region = String(body.region).toUpperCase();

    // Обновляем только если трекер принадлежит этому профилю
    const [row] = await db
      .update(trackers)
      .set(patch)
      .where(and(eq(trackers.id, Number(id)), eq(trackers.ownerKey, owner)))
      .returning();
    if (!row) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, tracker: row });
  } catch (e) {
    console.error("PATCH tracker failed:", e);
    return NextResponse.json({ success: false, error: "update_failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const { id } = await params;
    const [row] = await db
      .delete(trackers)
      .where(and(eq(trackers.id, Number(id)), eq(trackers.ownerKey, owner)))
      .returning();
    if (!row) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("DELETE tracker failed:", e);
    return NextResponse.json({ success: false, error: "delete_failed" }, { status: 500 });
  }
}
