import { NextResponse } from "next/server";
import { syncItemsFromGithub } from "@/lib/exbo";
import { ensureSchema } from "@/lib/ensure-schema";
import { isAdmin } from "@/lib/identity";

export const dynamic = "force-dynamic";
// Синхронизация тянет мегабайты с GitHub + пишет тысячи строк:
// даём запас по времени, чтобы холодный Neon успевал проснуться
export const maxDuration = 120;

export async function POST() {
  if (!(await isAdmin())) {
    return NextResponse.json({ success: false, error: "admin_only" }, { status: 403 });
  }
  try {
    try {
      await ensureSchema();
    } catch (e) {
      console.error("ensureSchema failed:", e);
    }
    const r = await syncItemsFromGithub();
    return NextResponse.json({ success: true, count: r.count });
  } catch (e) {
    console.error("sync failed:", e);
    return NextResponse.json(
      { success: false, error: "sync_failed" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return POST();
}
