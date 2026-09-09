import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { desc, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 30)));
    const rows = await db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    const unreadRes = await db.execute(
      sql`select count(*)::int as c from notifications where is_read = false`
    );
    const unread = Number((unreadRes.rows[0] as unknown as { c: number })?.c || 0);
    return NextResponse.json({ success: true, notifications: rows, unread });
  } catch (e) {
    console.error("GET /api/notifications failed:", e);
    return NextResponse.json({ success: false, notifications: [], unread: 0 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.all === true) {
      await db.execute(sql`update notifications set is_read = true where is_read = false`);
    } else if (body.id) {
      await db.execute(sql`update notifications set is_read = true where id = ${Number(body.id)}`);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("PATCH /api/notifications failed:", e);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    await db.execute(sql`delete from notifications`);
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
