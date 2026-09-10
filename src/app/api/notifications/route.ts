import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { getOwnerKey } from "@/lib/identity";
import { ensureSchema } from "@/lib/ensure-schema";

export const dynamic = "force-dynamic";

// Каждый видит только свои уведомления
export async function GET(req: NextRequest) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const { searchParams } = new URL(req.url);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 30)));
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.ownerKey, owner))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    const unread = rows.filter((r) => !r.isRead).length;
    return NextResponse.json({ success: true, notifications: rows, unread });
  } catch (e) {
    console.error("GET /api/notifications failed:", e);
    return NextResponse.json({ success: false, notifications: [], unread: 0 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    const body = await req.json().catch(() => ({}));
    if (body.all === true) {
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(and(eq(notifications.ownerKey, owner), eq(notifications.isRead, false)));
    } else if (body.id) {
      await db
        .update(notifications)
        .set({ isRead: true })
        .where(and(eq(notifications.ownerKey, owner), eq(notifications.id, Number(body.id))));
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/notifications failed:", e);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await ensureSchema();
    const owner = await getOwnerKey();
    await db.delete(notifications).where(eq(notifications.ownerKey, owner));
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
