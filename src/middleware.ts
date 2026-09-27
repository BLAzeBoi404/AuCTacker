import { NextRequest, NextResponse } from "next/server";

const OWNER_COOKIE = "auc_uid";
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Автоматический профиль устройства — без регистрации и входа.
 *
 * Middleware выполняется ДО всех страниц и API, поэтому идентификатор
 * выдаётся ровно один раз на первый же запрос браузера.
 *
 * Почему это важно: при первом заходе страница параллельно дёргает
 * /api/session, /api/trackers, /api/notifications, /api/items. Если бы
 * cookie ставил каждый обработчик отдельно, все они сгенерировали бы
 * РАЗНЫЕ идентификаторы и профиль «прыгал» бы. Здесь он один.
 */
export function middleware(request: NextRequest) {
  const existing = request.cookies.get(OWNER_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) {
    return NextResponse.next();
  }

  const fresh = crypto.randomUUID().replace(/-/g, "");

  // Кладём в текущий запрос, чтобы обработчик увидел профиль сразу
  request.cookies.set(OWNER_COOKIE, fresh);
  const response = NextResponse.next({ request });

  // И закрепляем в браузере на год
  response.cookies.set(OWNER_COOKIE, fresh, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|download).*)"],
};
