import { randomBytes } from "crypto";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

// Кэш настроек в памяти.
// TTL большой намеренно: фоновые задачи не должны будить базу каждую минуту,
// иначе Neon Free не засыпает и лимит CU-часов кончается к середине месяца.
// Записи через setSetting сразу обновляют кэш, поэтому изменения из админки
// применяются мгновенно, без ожидания TTL.
const cache = new Map<string, { v: string | null; exp: number }>();
const TTL_MS = 15 * 60 * 1000;

export async function getSetting(key: string): Promise<string | null> {
  const c = cache.get(key);
  if (c && Date.now() < c.exp) return c.v;
  try {
    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    const v = rows[0]?.value ?? null;
    cache.set(key, { v, exp: Date.now() + TTL_MS });
    return v;
  } catch {
    return c?.v ?? null;
  }
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
  cache.set(key, { v: value, exp: Date.now() + TTL_MS });
}

// Секрет для внешнего cron-пинга. Генерируется сам при первом обращении.
export async function getOrCreateSecret(): Promise<string> {
  let s = await getSetting("cron_secret");
  if (!s) {
    s = randomBytes(18).toString("hex");
    await setSetting("cron_secret", s);
  }
  return s;
}
