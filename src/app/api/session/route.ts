import { NextRequest, NextResponse } from "next/server";
import { getOwnerKey, isAdmin, adminConfigured, loginAdmin, logoutAdmin } from "@/lib/identity";
import { ensureScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

// Кто я: гость (свой профиль) или админ. Профиль создаётся автоматически.
export async function GET() {
  void ensureScheduler();
  const owner = await getOwnerKey();
  return NextResponse.json({
    success: true,
    ownerKey: owner.slice(0, 8), // короткий id для показа, не секрет
    isAdmin: await isAdmin(),
    adminConfigured: adminConfigured(),
  });
}

// Вход/выход админа по паролю
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { action?: string; password?: string };
  if (body.action === "logout") {
    await logoutAdmin();
    return NextResponse.json({ success: true, isAdmin: false });
  }
  const ok = await loginAdmin(String(body.password || ""));
  if (!ok) {
    return NextResponse.json({ success: false, error: "bad_password" }, { status: 401 });
  }
  return NextResponse.json({ success: true, isAdmin: true });
}
