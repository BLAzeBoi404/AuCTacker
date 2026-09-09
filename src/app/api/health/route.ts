import { db } from "@/db";
import { sql } from "drizzle-orm";
import { ensureScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  void ensureScheduler();
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
