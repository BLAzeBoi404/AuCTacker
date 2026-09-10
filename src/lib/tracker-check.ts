import { db } from "@/db";
import { trackers, notifications } from "@/db/schema";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { ExboApiError, fetchLots, type NormalizedLot } from "./exbo";
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
  failed: number;
  apiLots: number;
  errors: string[];
}

let activeCheck: Promise<CheckResult> | null = null;

function priceLabel(min: number, max: number): string {
  if (min > 0 && max > 0) return `${min.toLocaleString("ru-RU")}–${max.toLocaleString("ru-RU")} ₽`;
  if (min > 0) return `от ${min.toLocaleString("ru-RU")} ₽`;
  if (max > 0) return `до ${max.toLocaleString("ru-RU")} ₽`;
  return "любая цена";
}

async function fetchAllLots(itemId: string, region: string): Promise<{ lots: NormalizedLot[]; total: number }> {
  const result: NormalizedLot[] = [];
  let total = 0;
  for (let offset = 0; offset < 2000; offset += 100) {
    const page = await fetchLots(itemId, region, 100, offset);
    total = page.total;
    result.push(...page.lots);
    if (page.lots.length < 100 || result.length >= total) break;
  }
  if (total > result.length) {
    throw new ExboApiError(`EXBO сообщил ${total} лотов, но удалось получить только ${result.length}`, 502);
  }
  return { lots: [...new Map(result.map((lot) => [lot.id, lot])).values()], total };
}

async function deliverPending(
  chats: Awaited<ReturnType<typeof getActiveChats>>,
  siteUrl: string,
): Promise<number> {
  const pending = await db.select().from(notifications).where(and(
    isNull(notifications.sentAt),
    lte(notifications.retryAt, new Date()),
    gt(notifications.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
  )).orderBy(asc(notifications.id)).limit(20);

  let delivered = 0;
  for (const notification of pending) {
    const requested = Array.isArray(notification.targetChatIds) && notification.targetChatIds.length
      ? notification.targetChatIds
      : chats.map((chat) => chat.chatId);
    const sent = new Set(Array.isArray(notification.sentChatIds) ? notification.sentChatIds : []);
    let lastError: string | null = null;

    for (const chatId of requested) {
      if (sent.has(chatId)) continue;
      const chat = chats.find((candidate) => candidate.chatId === chatId);
      if (!chat) {
        lastError = "Telegram-чат отключён или не найден";
        continue;
      }
      const url = siteUrl ? `${siteUrl}/?item=${encodeURIComponent(notification.itemId)}` : undefined;
      const html =
        `🎯 <b>Новый лот: ${esc(notification.itemName)}</b>\n\n`
        + `Цена: <b>${notification.price.toLocaleString("ru-RU")} ₽</b>\n`
        + `${esc(notification.qualityName || "Обычный")} • +${notification.upgrade}\n`
        + `Регион: ${esc(notification.region)}\n`
        + `Источник: EXBO EAPI`;
      if (await sendTelegramMessage(chatId, html, url)) {
        sent.add(chatId);
        delivered++;
      } else {
        lastError = "Telegram временно не принял сообщение";
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }

    const complete = requested.length > 0 && requested.every((chatId) => sent.has(chatId));
    const attempts = notification.attempts + 1;
    await db.update(notifications).set({
      targetChatIds: requested,
      sentChatIds: [...sent],
      attempts,
      sentAt: complete ? new Date() : null,
      retryAt: complete ? new Date() : new Date(Date.now() + Math.min(60 * 60 * 1000, 30000 * 2 ** Math.min(attempts, 6))),
      deliveryError: complete ? null : (lastError || "Нет активного Telegram-чата"),
    }).where(eq(notifications.id, notification.id));
  }
  return delivered;
}

async function check(source: string): Promise<CheckResult> {
  const result: CheckResult = {
    checked: 0,
    matches: [],
    totalMatches: 0,
    initialized: 0,
    telegramSent: 0,
    failed: 0,
    apiLots: 0,
    errors: [],
  };

  const all = await db.select().from(trackers);
  const enabled = all.filter((tracker) => tracker.enabled);
  if (!enabled.length) return result;

  const groups = new Map<string, typeof enabled>();
  for (const tracker of enabled) {
    const key = `${tracker.region}|${tracker.itemId}`;
    groups.set(key, [...(groups.get(key) || []), tracker]);
  }

  const telegramEnabled = ((await getSetting("telegram_enabled")) ?? "1") === "1";
  const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
  const activeChats = telegramEnabled ? await getActiveChats() : [];

  for (const [key, group] of groups) {
    const [region, itemId] = key.split("|");
    let snapshot: { lots: NormalizedLot[]; total: number };
    try {
      snapshot = await fetchAllLots(itemId, region);
      result.apiLots += snapshot.total;
    } catch (error) {
      const message = error instanceof Error ? error.message : "EXBO EAPI недоступен";
      result.failed += group.length;
      result.errors.push(`${group[0].itemName}: ${message}`);
      for (const tracker of group) {
        await db.update(trackers).set({ lastCheckedAt: new Date(), lastError: message }).where(eq(trackers.id, tracker.id));
      }
      continue;
    }

    for (const tracker of group) {
      const seen = new Set(Array.isArray(tracker.lastSeenLotIds) ? tracker.lastSeenLotIds : []);
      const firstRun = tracker.lastCheckedAt === null && seen.size === 0;
      const currentIds = snapshot.lots.map((lot) => lot.id);
      const targets = (() => {
        const wanted = Array.isArray(tracker.notifyChatIds) ? tracker.notifyChatIds : [];
        return wanted.length ? activeChats.filter((chat) => wanted.includes(chat.chatId)) : activeChats;
      })();

      const matching = snapshot.lots.filter((lot) => {
        const price = lot.buyoutPrice || lot.startPrice || 0;
        const upgradeMatches = tracker.upgradeMode === "any"
          || (tracker.upgradeMode === "exact" && lot.upgrade === tracker.targetUpgrade)
          || (tracker.upgradeMode === "min" && lot.upgrade >= tracker.targetUpgrade);
        return upgradeMatches
          && (tracker.targetQuality === -1 || lot.quality === tracker.targetQuality)
          && (tracker.maxPrice === 0 || (price > 0 && price <= tracker.maxPrice))
          && (tracker.minPrice === 0 || (price > 0 && price >= tracker.minPrice));
      });

      result.checked++;
      result.totalMatches += matching.length;
      if (firstRun) result.initialized++;

      let reportSent = tracker.initialReportSent;
      if (!reportSent && targets.length) {
        const quality = tracker.targetQuality === -1 ? "любая редкость" : QUALITY_NAMES[tracker.targetQuality];
        const upgrade = tracker.upgradeMode === "any"
          ? "любая заточка"
          : tracker.upgradeMode === "min"
            ? `от +${tracker.targetUpgrade}`
            : `точно +${tracker.targetUpgrade}`;
        const report =
          `✅ <b>Трекер активен: ${esc(tracker.itemName)}</b>\n\n`
          + `Источник: официальный EXBO EAPI\n`
          + `Регион: ${esc(tracker.region)}\n`
          + `EXBO вернул лотов: <b>${snapshot.total}</b>\n`
          + `Под условия подходит: <b>${matching.length}</b>\n`
          + `Условия: ${esc(upgrade)}, ${esc(quality)}, ${esc(priceLabel(tracker.minPrice, tracker.maxPrice))}\n\n`
          + `Если лот уже виден в игре, но его нет на сайте, официальный API ещё не передал его. AuCTracker не может увидеть лот раньше EXBO.`;
        for (const target of targets) {
          if (await sendTelegramMessage(target.chatId, report)) {
            result.telegramSent++;
            reportSent = true;
          }
        }
      }

      let newCount = 0;
      if (!firstRun) {
        for (const lot of matching) {
          if (seen.has(lot.id)) continue;
          const price = lot.buyoutPrice || lot.startPrice || 0;
          const match: CheckMatch = {
            trackerId: tracker.id,
            itemId: tracker.itemId,
            itemName: tracker.itemName,
            itemIcon: tracker.itemIcon,
            region: tracker.region,
            lotId: lot.id,
            price,
            upgrade: lot.upgrade,
            quality: lot.quality,
            qualityName: QUALITY_NAMES[lot.quality] || "Обычный",
            endTime: lot.endTime,
            isNew: true,
          };
          result.matches.push(match);
          newCount++;

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
            qualityName: match.qualityName,
            message: `+${lot.upgrade} • ${match.qualityName} • ${price.toLocaleString("ru-RU")} ₽`,
            targetChatIds: targets.map((target) => target.chatId),
            sentChatIds: [],
            retryAt: new Date(),
          }).onConflictDoNothing();
        }
      }

      await db.update(trackers).set({
        lastSeenLotIds: currentIds.slice(0, 2000),
        lastCheckedAt: new Date(),
        lastResultCount: matching.length,
        lastApiTotal: snapshot.total,
        lastError: null,
        initialReportSent: reportSent,
        matchCount: tracker.matchCount + newCount,
        ...(newCount ? { lastMatchedAt: new Date() } : {}),
      }).where(eq(trackers.id, tracker.id));
    }
  }

  result.telegramSent += await deliverPending(activeChats, siteUrl);

  try {
    await db.execute(sql`delete from notifications where id not in (select id from notifications order by created_at desc limit 300)`);
  } catch {
    // Очистка истории не должна ломать проверку.
  }

  console.log(`Tracker check [${source}]: checked=${result.checked}, apiLots=${result.apiLots}, matching=${result.totalMatches}, new=${result.matches.length}, telegram=${result.telegramSent}, failed=${result.failed}`);
  return result;
}

export async function runTrackerCheck(source: string): Promise<CheckResult> {
  if (activeCheck) return activeCheck;
  activeCheck = check(source);
  try {
    return await activeCheck;
  } finally {
    activeCheck = null;
  }
}
