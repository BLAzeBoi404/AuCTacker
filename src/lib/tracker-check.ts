import { db } from "@/db";
import { trackers, notifications } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { fetchLotsPages, type NormalizedLot } from "./exbo";
import { QUALITY_NAMES } from "./constants";
import { getSetting } from "./settings";
import { getActiveChats, sendTelegramMessage, esc } from "./telegram";

export interface CheckMatch {
  trackerId: number;
  itemId: string;
  itemName: string;
  itemIcon: string | null;
  region: string;
  lotId: string;
  price: number;
  upgrade: number;
  quality: number;
  qualityName: string;
  endTime: string | null;
  isNew: boolean;
}

export interface CheckResult {
  checked: number;
  matches: CheckMatch[];
  totalMatches: number;
  initialized: number;
  telegramSent: number;
}

// Единый движок проверки трекеров. Используется планировщиком, cron-пингом и сайтом.
// Уведомления (в т.ч. Telegram) — только по НОВЫМ лотам.
// Первая проверка трекера — тихая инициализация без уведомлений (защита от спама).
export async function runTrackerCheck(source: string): Promise<CheckResult> {
  const empty: CheckResult = {
    checked: 0,
    matches: [],
    totalMatches: 0,
    initialized: 0,
    telegramSent: 0,
  };
  let all: (typeof trackers.$inferSelect)[];
  try {
    all = await db.select().from(trackers);
  } catch (e) {
    console.error(`tracker check [${source}] db failed:`, e);
    return empty;
  }
  const enabled = all.filter((t) => t.enabled);
  if (enabled.length === 0) return empty;

  // Группируем по предмет+регион, чтобы не дублировать запросы к EAPI
  const groups = new Map<string, typeof enabled>();
  for (const t of enabled) {
    const key = `${t.itemId}|${t.region}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const tgEnabled = ((await getSetting("telegram_enabled")) ?? "1") === "1";
  const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
  const activeChats = tgEnabled ? await getActiveChats() : [];

  const matches: CheckMatch[] = [];
  const firstRunWithMatches = new Set<number>();
  const tgSentPerTracker = new Map<number, number>();
  let telegramSent = 0;
  let notifInserted = 0;

  // Все предметы проверяются параллельно — при десятках трекеров это
  // разница между секундами и долями секунды.
  const groupEntries = Array.from(groups.entries());
  const groupLotsResults = await Promise.all(
    groupEntries.map(async ([key]) => {
      const [itemId, region] = key.split("|");
      try {
        // Смотрим оба конца ценового диапазона параллельно: 100 самых
        // дешёвых (кто ищет выгодную цену) + 100 самых дорогих (кто ищет
        // редкую заточку/качество вне зависимости от цены). Так трекер не
        // пропустит совпадение, даже если у предмета тысячи активных лотов.
        const [cheap, expensive] = await Promise.all([
          fetchLotsPages(itemId, region, 1, "buyout_price", "asc"),
          fetchLotsPages(itemId, region, 1, "buyout_price", "desc"),
        ]);
        const byId = new Map<string, NormalizedLot>();
        for (const l of cheap.lots) byId.set(l.id, l);
        for (const l of expensive.lots) byId.set(l.id, l);
        return { key, lots: Array.from(byId.values()) };
      } catch (e) {
        console.error(`tracker check [${source}] lots failed for ${itemId}:`, e);
        return { key, lots: [] as NormalizedLot[] };
      }
    })
  );
  const lotsByGroup = new Map(groupLotsResults.map((r) => [r.key, r.lots]));

  for (const [key, list] of groupEntries) {
    const lots = lotsByGroup.get(key) || [];

    for (const tracker of list) {
      const seen: string[] = Array.isArray(tracker.lastSeenLotIds)
        ? tracker.lastSeenLotIds
        : [];
      const isFirstRun = tracker.lastCheckedAt === null && seen.length === 0;
      const seenSet = new Set(seen);
      const currentIds: string[] = [];
      let newCount = 0;

      const wanted: string[] = Array.isArray(tracker.notifyChatIds)
        ? tracker.notifyChatIds
        : [];
      // Пустой список = слать всем привязанным чатам
      const targets =
        wanted.length > 0
          ? activeChats.filter((c) => wanted.includes(c.chatId))
          : activeChats;

      for (const lot of lots) {
        currentIds.push(lot.id);
        const price = lot.buyoutPrice || lot.startPrice || 0;

        let matchUp = true;
        if (tracker.upgradeMode === "exact")
          matchUp = lot.upgrade === tracker.targetUpgrade;
        else if (tracker.upgradeMode === "min")
          matchUp = lot.upgrade >= tracker.targetUpgrade;
        // "any" -> всегда true

        const matchQlt =
          tracker.targetQuality === -1 || lot.quality === tracker.targetQuality;
        const matchMax =
          tracker.maxPrice === 0 || (price > 0 && price <= tracker.maxPrice);
        const matchMin =
          tracker.minPrice === 0 || (price > 0 && price >= tracker.minPrice);
        if (!(matchUp && matchQlt && matchMax && matchMin)) continue;

        const isNew = !seenSet.has(lot.id);
        matches.push({
          trackerId: tracker.id,
          itemId: tracker.itemId,
          itemName: tracker.itemName,
          itemIcon: tracker.itemIcon,
          region: tracker.region,
          lotId: lot.id,
          price,
          upgrade: lot.upgrade,
          quality: lot.quality,
          qualityName: QUALITY_NAMES[lot.quality] ?? "Обычный",
          endTime: lot.endTime,
          isNew,
        });
        if (!isNew) continue;
        newCount++;
        if (isFirstRun) continue; // тихая инициализация — запоминаем, но не шумим

        if (notifInserted < 30) {
          try {
            await db.insert(notifications).values({
              trackerId: tracker.id,
              itemId: tracker.itemId,
              itemName: tracker.itemName,
              itemIcon: tracker.itemIcon,
              region: tracker.region,
              lotId: lot.id,
              price,
              upgrade: lot.upgrade,
              quality: lot.quality,
              qualityName: QUALITY_NAMES[lot.quality] ?? "Обычный",
              message: `+${lot.upgrade} • ${QUALITY_NAMES[lot.quality] ?? ""} • ${price.toLocaleString("ru-RU")} ₽`,
            });
            notifInserted++;
          } catch {
              /* ignore */
          }
        }

        // Telegram: максимум 5 сообщений на трекер за проверку (защита от флуда)
        const sentForTracker = tgSentPerTracker.get(tracker.id) || 0;
        if (targets.length > 0 && sentForTracker < 5) {
          const qn = QUALITY_NAMES[lot.quality] ?? "";
          const itemUrl = siteUrl
            ? `${siteUrl}/?item=${encodeURIComponent(tracker.itemId)}`
            : undefined;
          const html =
            `🎯 <b>${esc(tracker.itemName)}</b>\n` +
            `+${lot.upgrade} • ${esc(qn)} • <b>${price.toLocaleString("ru-RU")} ₽</b>\n` +
            `Регион: ${esc(tracker.region)}`;
          for (const t of targets) {
            try {
              const ok = await sendTelegramMessage(t.chatId, html, itemUrl);
              if (ok) telegramSent++;
            } catch {
              /* ignore */
            }
          }
          tgSentPerTracker.set(tracker.id, sentForTracker + 1);
        }
      }

      if (isFirstRun && newCount > 0) firstRunWithMatches.add(tracker.id);

      try {
        await db
          .update(trackers)
          .set({
            lastSeenLotIds: currentIds.slice(0, 300),
            lastCheckedAt: new Date(),
            matchCount: (tracker.matchCount || 0) + (isFirstRun ? 0 : newCount),
            ...(newCount > 0 && !isFirstRun
              ? { lastMatchedAt: new Date() }
              : {}),
          })
          .where(eq(trackers.id, tracker.id));
      } catch {
        /* ignore */
      }
    }
  }

  // Чистим старые уведомления, храним последние 300
  try {
    await db.execute(
      sql`delete from notifications where id not in (select id from notifications order by created_at desc limit 300)`
    );
  } catch {
    /* ignore */
  }

  const fresh = matches.filter(
    (m) => m.isNew && !firstRunWithMatches.has(m.trackerId)
  );
  return {
    checked: enabled.length,
    matches: fresh,
    totalMatches: matches.length,
    initialized: firstRunWithMatches.size,
    telegramSent,
  };
}
