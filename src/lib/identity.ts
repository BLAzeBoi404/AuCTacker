import { cookies } from "next/headers";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const OWNER_COOKIE = "auc_uid";
const ADMIN_COOKIE = "auc_admin";
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Возвращает стабильный идентификатор пользователя (профиль браузера).
 * Каждый компьютер/браузер получает свой ownerKey автоматически при первом заходе.
 * Ничего вводить не нужно — работает как «гостевой аккаунт» на устройство.
 */
export async function getOwnerKey(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(OWNER_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;

  const fresh = randomBytes(16).toString("hex");
  jar.set(OWNER_COOKIE, fresh, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return fresh;
}

/** Читает ownerKey, не создавая новый (для фоновых задач это не нужно). */
export async function peekOwnerKey(): Promise<string | null> {
  const jar = await cookies();
  const existing = jar.get(OWNER_COOKIE)?.value;
  return existing && /^[a-f0-9]{32}$/.test(existing) ? existing : null;
}

// ---------- Админ ----------

function adminSecret(): string {
  // Пароль админки задаётся в переменной окружения ADMIN_PASSWORD на хостинге.
  // Если не задан — админка недоступна никому (безопасно по умолчанию).
  return process.env.ADMIN_PASSWORD || "";
}

function signAdmin(payload: string): string {
  return createHmac("sha256", adminSecret() || "disabled")
    .update(payload)
    .digest("hex");
}

/** Проверяет пароль и, если верный, ставит подписанную cookie админа. */
export async function loginAdmin(password: string): Promise<boolean> {
  const secret = adminSecret();
  if (!secret) return false;
  const a = Buffer.from(password);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

  const issuedAt = String(Date.now());
  const token = `${issuedAt}.${signAdmin(issuedAt)}`;
  const jar = await cookies();
  jar.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: ONE_YEAR,
    path: "/",
  });
  return true;
}

export async function logoutAdmin(): Promise<void> {
  const jar = await cookies();
  jar.delete(ADMIN_COOKIE);
}

/** true, если у пользователя валидная админ-cookie (и пароль вообще задан). */
export async function isAdmin(): Promise<boolean> {
  if (!adminSecret()) return false;
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  const [issuedAt, sig] = token.split(".");
  if (!issuedAt || !sig) return false;
  const expected = signAdmin(issuedAt);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Задан ли пароль админки на сервере. */
export function adminConfigured(): boolean {
  return adminSecret().length > 0;
}
