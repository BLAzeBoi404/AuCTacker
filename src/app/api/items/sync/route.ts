import { NextResponse } from "next/server";
import { syncItemsFromGithub } from "@/lib/exbo";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
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
