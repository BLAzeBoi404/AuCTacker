import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { sellTrackers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getOwnerKey } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";
import { invalidateTrackerCache } from "@/lib/tracker-check";
import { invalidateOwner } from "@/lib/user-cache";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const { id } = await params;
    const [row] = await db
      .delete(sellTrackers)
      .where(and(eq(sellTrackers.id, Number(id)), eq(sellTrackers.ownerKey, owner)))
      .returning();
    if (!row) {
      return NextResponse.json({ success: false, error: "not_found" }, { status: 404 });
    }
    invalidateTrackerCache();
    invalidateOwner(owner);
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("DELETE sell-tracker failed:", e);
    return NextResponse.json({ success: false, error: "delete_failed" }, { status: 500 });
  }
}
