import { db } from "@/db";
import { trackers, notifications, sellTrackers } from "@/db/schema";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { ExboApiError, fetchHistoryAll, fetchLotsAll, type NormalizedLot } from "./exbo";
import { QUALITY_NAMES } from "./constants";
import { getSetting } from "./settings";
import { getActiveChats, sendTelegramMessage, esc } from "./telegram";
import { invalidateAll } from "./user-cache";

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
  /** Обращались ли к базе в этом цикле (для экономии CU-часов Neon) */
  dbTouched: boolean;
  /** Возраст кэша состояния в секундах */
  stateAgeSec: number;
  /** Трекеры продаж */
  sellChecked: number;
  sellSold: number;
  sellExpired: number;
}

type TrackerRow = typeof trackers.$inferSelect;
type ChatRow = { chatId: string; name: string | null; ownerKey: string | null };

/**
 * ЭКОНОМИЯ БАЗЫ (важно для бесплатного Neon).
 *
 * Neon Free даёт 100 CU-часов в месяц и засыпает после 5 минут без запросов.
 * Если дёргать базу каждую минуту, она не спит никогда: 0.25 CU × 730 ч ≈ 180
 * CU-часов — лимит кончается примерно на 17-й день.
 *
 * Поэтому: список трекеров и чатов держим в памяти и обновляем редко
 * (db_sync_interval, по умолчанию 15 минут). Аукцион EXBO при этом опрашиваем
 * часто — это внешний API, он на счётчик Neon не влияет.
 *
 * К базе идём только когда это действительно нужно:
 *   1) плановая синхронизация состояния;
 *   2) найден новый лот (запись уведомления + отметка «просмотрено»);
 *   3) пользователь открыл сайт (обычные запросы страниц).
 *
 * Между этими моментами база спит и CU-часы не тратятся.
 */
type SellTrackerRow = typeof sellTrackers.$inferSelect;

interface EcoState {
  trackers: TrackerRow[];
  sellTrackers: SellTrackerRow[];
  chats: ChatRow[];
  telegramEnabled: boolean;
  siteUrl: string;
  syncMs: number;
  /** Включён ли фоновый трекинг */
  schedulerEnabled: boolean;
  /** Как часто опрашивать EXBO (внешний API, базу не трогает) */
  checkIntervalMs: number;
  loadedAt: number;
}

let state: EcoState | null = null;
let activeCheck: Promise<CheckResult> | null = null;
let hasPendingDeliveries = false;

/** Отложенные записи: копятся в памяти, уходят в базу одной пачкой */
interface PendingWrite {
  lastSeenLotIds: string[];
  /** null — трекер ещё ни разу не проверялся успешно (базовый снимок не снят) */
  lastCheckedAt: Date | null;
  lastResultCount: number;
  lastApiTotal: number;
  lastError: string | null;
}
const pending = new Map<number, PendingWrite>();

/** Отложенные отметки продаж: last_seen_at + miss_count без пробуждения базы */
interface PendingSellWrite {
  lastSeenAt: Date;
  missCount: number;
}
const pendingSell = new Map<number, PendingSellWrite>();

/** Сбросить кэш — вызывается при создании/изменении/удалении трекера */
export function invalidateTrackerCache(): void {
  state = null;
}

function priceLabel(min: number, max: number): string {
  if (min > 0 && max > 0) return `${min.toLocaleString("ru-RU")}–${max.toLocaleString("ru-RU")} ₽`;
  if (min > 0) return `от ${min.toLocaleString("ru-RU")} ₽`;
  if (max > 0) return `до ${max.toLocaleString("ru-RU")} ₽`;
  return "любая цена";
}

/** Записывает накопленные изменения трекеров одной пачкой */
async function flushPending(): Promise<boolean> {
  let wrote = false;
  if (pending.size > 0) {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [id, w] of entries) {
      try {
        await db.update(trackers).set({
          lastSeenLotIds: w.lastSeenLotIds.slice(0, 2000),
          lastCheckedAt: w.lastCheckedAt,
          lastResultCount: w.lastResultCount,
          lastApiTotal: w.lastApiTotal,
          lastError: w.lastError,
        }).where(eq(trackers.id, id));
        wrote = true;
      } catch (e) {
        console.error("flushPending failed for tracker", id, e);
      }
    }
  }
  if (pendingSell.size > 0) {
    const entries = [...pendingSell.entries()];
    pendingSell.clear();
    for (const [id, w] of entries) {
      try {
        await db.update(sellTrackers).set({
          lastSeenAt: w.lastSeenAt,
          missCount: w.missCount,
        }).where(eq(sellTrackers.id, id));
        wrote = true;
      } catch (e) {
        console.error("flushPending failed for sell tracker", id, e);
      }
    }
  }
  return wrote;
}

async function loadState(): Promise<EcoState> {
  await flushPending();
  const [rows, sellRows] = await Promise.all([
    db.select().from(trackers),
    db.select().from(sellTrackers).where(eq(sellTrackers.status, "active")),
  ]);
  const telegramEnabled = ((await getSetting("telegram_enabled")) ?? "1") === "1";
  const siteUrl = ((await getSetting("site_url")) || "").replace(/\/$/, "");
  const syncSec = Math.min(3600, Math.max(60, Number(await getSetting("db_sync_interval")) || 1800));
  const schedulerEnabled = ((await getSetting("scheduler_enabled")) ?? "1") === "1";
  const checkSec = Math.min(3600, Math.max(30, Number(await getSetting("scheduler_interval")) || 60));
  const chats = telegramEnabled ? await getActiveChats() : [];

  // Раз в цикл синхронизации подчищаем историю уведомлений
  try {
    await db.execute(
      sql`delete from notifications where id not in (select id from notifications order by created_at desc limit 300)`
    );
  } catch {
    /* очистка не должна ломать проверку */
  }

  hasPendingDeliveries = true; // после перезапуска проверим неотправленные
  return {
    trackers: rows,
    sellTrackers: sellRows,
    chats,
    telegramEnabled,
    siteUrl,
    syncMs: syncSec * 1000,
    schedulerEnabled,
    checkIntervalMs: checkSec * 1000,
    loadedAt: Date.now(),
  };
}

/** Конфиг планировщика из кэша — без обращения к базе */
export function getRuntimeConfig(): { enabled: boolean; checkIntervalMs: number } {
  return {
    enabled: state ? state.schedulerEnabled : true,
    checkIntervalMs: state ? state.checkIntervalMs : 60_000,
  };
}

async function fetchAllLots(itemId: string, region: string): Promise<{ lots: NormalizedLot[]; total: number }> {
  const { lots, total } = await fetchLotsAll(itemId, region, 2000);
  if (total > lots.length && lots.length < 2000) {
    throw new ExboApiError(`EXBO сообщил ${total} лотов, но удалось получить только ${lots.length}`, 502);
  }
  return { lots, total };
}

/** Дослать уведомления, которые не ушли с первой попытки */
async function deliverPending(chats: ChatRow[], siteUrl: string): Promise<number> {
  const rows = await db.select().from(notifications).where(and(
    isNull(notifications.sentAt),
    lte(notifications.retryAt, new Date()),
    gt(notifications.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
  )).orderBy(asc(notifications.id)).limit(20);

  if (rows.length === 0) {
    hasPendingDeliveries = false;
    return 0;
  }

  let delivered = 0;
  for (const notification of rows) {
    // Досылаем только тем чатам, кому это уведомление адресовано.
    // Если адресатов нет — помечаем как доставленное и больше не трогаем.
    const requested = Array.isArray(notification.targetChatIds)
      ? notification.targetChatIds.filter((chatId) =>
          chats.some((chat) => chat.chatId === chatId),
        )
      : [];
    const sent = new Set(Array.isArray(notification.sentChatIds) ? notification.sentChatIds : []);
    let lastError: string | null = null;

    for (const chatId of requested) {
      if (sent.has(chatId)) continue;
      if (!chats.some((c) => c.chatId === chatId)) {
        lastError = "Telegram-чат отключён или не найден";
        continue;
      }
      const url = siteUrl ? `${siteUrl}/?item=${encodeURIComponent(notification.itemId)}` : undefined;
      const kind = (notification as { kind?: string }).kind || "buy";
      const html =
        kind === "sell_sold"
          ? `✅ <b>Предмет продан: ${esc(notification.itemName)}</b>\n\n`
            + `Цена продажи: <b>${notification.price.toLocaleString("ru-RU")} ₽</b>\n`
            + `${esc(notification.qualityName || "Обычный")} • +${notification.upgrade}\n`
            + `Регион: ${esc(notification.region)}\n`
            + `Можно забирать деньги с аукциона.`
          : kind === "sell_expired"
            ? `⌛ <b>Срок лота истёк: ${esc(notification.itemName)}</b>\n\n`
              + `Цена была: <b>${notification.price.toLocaleString("ru-RU")} ₽</b>\n`
              + `${esc(notification.qualityName || "Обычный")} • +${notification.upgrade}\n`
              + `Регион: ${esc(notification.region)}\n`
              + `Лот пропал из аукциона после окончания срока. Заберите предмет обратно.`
            : `🎯 <b>Новый лот: ${esc(notification.itemName)}</b>\n\n`
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

    const complete = requested.every((chatId) => sent.has(chatId));
    const attempts = notification.attempts + 1;
    await db.update(notifications).set({
      targetChatIds: requested,
      sentChatIds: [...sent],
      attempts,
      sentAt: complete ? new Date() : null,
      retryAt: complete ? new Date() : new Date(Date.now() + Math.min(60 * 60 * 1000, 30000 * 2 ** Math.min(attempts, 6))),
      deliveryError: complete ? null : (lastError || "Адресат недоступен или не привязан"),
    }).where(eq(notifications.id, notification.id));
  }
  hasPendingDeliveries = true;
  return delivered;
}

/** Отпечаток лота продажи для поиска среди активных лотов */
function sellLotMatches(
  lot: NormalizedLot,
  s: { targetLotId: string | null; price: number; amount: number; upgrade: number; quality: number; expectedEndTime: Date | null },
): boolean {
  if (s.targetLotId && lot.id === s.targetLotId) return true;
  const price = lot.buyoutPrice || lot.startPrice || 0;
  if (price !== s.price || lot.amount !== s.amount || lot.upgrade !== s.upgrade || lot.quality !== s.quality) {
    return false;
  }
  if (s.expectedEndTime && lot.endTime) {
    return Math.abs(new Date(lot.endTime).getTime() - s.expectedEndTime.getTime()) < 120_000;
  }
  return true;
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
    dbTouched: false,
    stateAgeSec: 0,
    sellChecked: 0,
    sellSold: 0,
    sellExpired: 0,
  };

  // 1. Состояние: из памяти или из базы (редко)
  let current = state;
  if (!current || Date.now() - current.loadedAt > current.syncMs) {
    current = await loadState();
    state = current;
    result.dbTouched = true;
  }
  result.stateAgeSec = Math.round((Date.now() - current.loadedAt) / 1000);

  if (!current.schedulerEnabled && source === "scheduler") return result;

  const enabled = current.trackers.filter((tracker) => tracker.enabled);
  const activeSell = current.sellTrackers.filter((s) => s.status === "active");
  if (!enabled.length && !activeSell.length) return result;

  const chatsByOwner = new Map<string, ChatRow[]>();
  for (const chat of current.chats) {
    if (!chat.ownerKey) continue;
    chatsByOwner.set(chat.ownerKey, [...(chatsByOwner.get(chat.ownerKey) || []), chat]);
  }

  // Снимки аукциона кэшируем в пределах одного цикла: один предмет+регион —
  // один набор запросов к EXBO, сколько бы трекеров (покупки + продажи) его ни смотрели
  const snapshots = new Map<string, { lots: NormalizedLot[]; total: number }>();
  async function getSnapshot(region: string, itemId: string) {
    const k = `${region}|${itemId}`;
    const hit = snapshots.get(k);
    if (hit) return hit;
    const snap = await fetchAllLots(itemId, region);
    result.apiLots += snap.total;
    snapshots.set(k, snap);
    return snap;
  }

  const groups = new Map<string, TrackerRow[]>();
  for (const tracker of enabled) {
    const key = `${tracker.region}|${tracker.itemId}`;
    groups.set(key, [...(groups.get(key) || []), tracker]);
  }

  for (const [key, group] of groups) {
    const [region, itemId] = key.split("|");

    // 2. Запрос к EXBO — внешний API, базу не трогает
    let snapshot: { lots: NormalizedLot[]; total: number };
    try {
      snapshot = await getSnapshot(region, itemId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "EXBO EAPI недоступен";
      result.failed += group.length;
      result.errors.push(`${group[0].itemName}: ${message}`);
      for (const tracker of group) {
        tracker.lastError = message;
        // ВАЖНО: lastCheckedAt НЕ трогаем при ошибке.
        // Иначе трекер считался бы «уже проверенным» с пустым списком лотов,
        // и первая же успешная проверка прислала бы разом весь аукцион.
        pending.set(tracker.id, {
          lastSeenLotIds: Array.isArray(tracker.lastSeenLotIds) ? tracker.lastSeenLotIds : [],
          lastCheckedAt: tracker.lastCheckedAt ?? null,
          lastResultCount: tracker.lastResultCount,
          lastApiTotal: tracker.lastApiTotal,
          lastError: message,
        });
      }
      continue;
    }

    for (const tracker of group) {
      const seen = new Set(Array.isArray(tracker.lastSeenLotIds) ? tracker.lastSeenLotIds : []);
      const firstRun = tracker.lastCheckedAt === null && seen.size === 0;
      const currentIds = snapshot.lots.map((lot) => lot.id);
      // Уведомления уходят ТОЛЬКО владельцу трекера.
      // Раньше трекеры без owner_key (созданные до разделения профилей) шла всем
      // привязанным чатам — поэтому друзья получали чужие уведомления.
      // Теперь такой трекер никому не шлёт: владельцу достаточно открыть «Трекеры»
      // и пересоздать его — новый будет привязан к его профилю автоматически.
      const targets = tracker.ownerKey ? (chatsByOwner.get(tracker.ownerKey) || []) : [];

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

      // Стартовый отчёт — один раз на трекер
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
          + `Дальше сообщу, как только появится новый подходящий лот.`;
        for (const target of targets) {
          if (await sendTelegramMessage(target.chatId, report)) {
            result.telegramSent++;
            reportSent = true;
          }
        }
        if (reportSent) {
          tracker.initialReportSent = true;
          try {
            await db.update(trackers).set({ initialReportSent: true }).where(eq(trackers.id, tracker.id));
            result.dbTouched = true;
          } catch { /* повторим в следующий раз */ }
        }
      }

      // 3. Новые лоты — единственный случай, когда база нужна немедленно
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

          try {
            await db.insert(notifications).values({
              kind: "buy",
              ownerKey: tracker.ownerKey,
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
            result.dbTouched = true;
            hasPendingDeliveries = true;
            invalidateAll(); // у пользователя появилось новое уведомление
          } catch (e) {
            console.error("notification insert failed:", e);
          }
        }
      }

      // Обновляем состояние в памяти
      tracker.lastSeenLotIds = currentIds.slice(0, 2000);
      tracker.lastCheckedAt = new Date();
      tracker.lastResultCount = matching.length;
      tracker.lastApiTotal = snapshot.total;
      tracker.lastError = null;
      if (newCount) {
        tracker.matchCount += newCount;
        tracker.lastMatchedAt = new Date();
      }

      if (newCount) {
        // Есть новые лоты — сохраняем сразу, чтобы после перезапуска не задвоить
        try {
          await db.update(trackers).set({
            lastSeenLotIds: tracker.lastSeenLotIds,
            lastCheckedAt: tracker.lastCheckedAt,
            lastResultCount: tracker.lastResultCount,
            lastApiTotal: tracker.lastApiTotal,
            lastError: null,
            matchCount: tracker.matchCount,
            lastMatchedAt: tracker.lastMatchedAt,
          }).where(eq(trackers.id, tracker.id));
          pending.delete(tracker.id);
          result.dbTouched = true;
        } catch (e) {
          console.error("tracker update failed:", e);
        }
      } else {
        // Ничего нового — откладываем запись, база продолжает спать
        pending.set(tracker.id, {
          lastSeenLotIds: tracker.lastSeenLotIds,
          lastCheckedAt: tracker.lastCheckedAt,
          lastResultCount: tracker.lastResultCount,
          lastApiTotal: tracker.lastApiTotal,
          lastError: null,
        });
      }
    }
  }

  // 4. Трекеры ПРОДАЖ: следим, что наш лот всё ещё на аукционе
  result.sellChecked = activeSellForCheck(current).length;
  for (const sell of activeSellForCheck(current)) {
    try {
      const snap = await getSnapshot(sell.region, sell.itemId);
      const expectedEnd = sell.expectedEndTime ? new Date(sell.expectedEndTime) : null;
      const found = snap.lots.some((lot) =>
        sellLotMatches(lot, {
          targetLotId: sell.targetLotId,
          price: sell.price,
          amount: sell.amount ?? 1,
          upgrade: sell.upgrade ?? 0,
          quality: sell.quality ?? 0,
          expectedEndTime: expectedEnd,
        }),
      );
      if (found) {
        // Лот на месте — обновляем отметку в памяти, в базу пишем отложенно
        sell.lastSeenAt = new Date();
        sell.missCount = 0;
        pendingSell.set(sell.id, { lastSeenAt: sell.lastSeenAt, missCount: 0 });
        continue;
      }

      // Лота нет в выдаче. Требуется 2 подряд промаха — защита от глюков EAPI.
      const misses = (sell.missCount ?? 0) + 1;
      sell.missCount = misses;
      if (misses < 2) {
        pendingSell.set(sell.id, { lastSeenAt: sell.lastSeenAt ?? new Date(), missCount: misses });
        continue;
      }

      // Исчезновение подтверждено. Продан или истёк?
      const now = new Date();
      const endTs = expectedEnd ? expectedEnd.getTime() : null;
      const expiredByTime = endTs !== null && now.getTime() >= endTs - 5 * 60_000;

      // Ищем подтверждение продажи в истории: та же цена/заточка/редкость после привязки
      let soldAt: Date | null = null;
      try {
        const hist = await fetchHistoryAll(sell.itemId, sell.region, 100);
        const since = (sell.createdAt ? new Date(sell.createdAt).getTime() : 0) - 10 * 60_000;
        const hit = hist.history.find(
          (h) =>
            h.price === sell.price &&
            h.upgrade === (sell.upgrade ?? 0) &&
            h.quality === (sell.quality ?? 0) &&
            h.time !== null &&
            new Date(h.time).getTime() >= since,
        );
        if (hit?.time) soldAt = new Date(hit.time);
      } catch {
        // историю не получили — решаем по сроку
      }

      const sold = soldAt !== null || !expiredByTime;
      const status = sold ? "sold" : "expired";
      const finishedAt = soldAt ?? now;
      if (sold) result.sellSold++;
      else result.sellExpired++;

      await db.update(sellTrackers).set({
        status,
        finishedAt,
        finishPrice: sell.price,
        missCount: misses,
      }).where(eq(sellTrackers.id, sell.id));
      sell.status = status;
      sell.finishedAt = finishedAt;
      pendingSell.delete(sell.id);
      invalidateAll();
      result.dbTouched = true;

      // Уведомление в общую очередь с пометкой вида — уйдёт в Telegram с нужным текстом
      const kind = sold ? "sell_sold" : "sell_expired";
      const qn = sell.qualityName || QUALITY_NAMES[sell.quality ?? 0] || "Обычный";
      await db.insert(notifications).values({
        kind,
        ownerKey: sell.ownerKey,
        trackerId: null,
        itemId: sell.itemId,
        itemName: sell.itemName,
        itemIcon: sell.itemIcon,
        region: sell.region,
        lotId: sell.targetLotId,
        price: sell.price,
        upgrade: sell.upgrade ?? 0,
        quality: sell.quality ?? 0,
        qualityName: qn,
        message: sold
          ? `Продан за ${sell.price.toLocaleString("ru-RU")} ₽`
          : `Срок истёк, лот пропал из аукциона`,
        targetChatIds: (sell.ownerKey ? (chatsByOwner.get(sell.ownerKey) || []) : []).map((c) => c.chatId),
        sentChatIds: [],
        retryAt: new Date(),
      }).onConflictDoNothing();
      hasPendingDeliveries = true;
    } catch (e) {
      console.error("sell tracker check failed:", sell.id, e instanceof Error ? e.message : e);
    }
  }

  // 5. Досылка застрявших уведомлений — только если есть что досылать
  if (hasPendingDeliveries) {
    try {
      result.telegramSent += await deliverPending(current.chats, current.siteUrl);
      result.dbTouched = true;
    } catch (e) {
      console.error("deliverPending failed:", e);
    }
  }

  console.log(
    `Tracker check [${source}]: checked=${result.checked}, apiLots=${result.apiLots}, `
    + `matching=${result.totalMatches}, new=${result.matches.length}, telegram=${result.telegramSent}, `
    + `failed=${result.failed}, sell=${result.sellChecked}/${result.sellSold}/${result.sellExpired}, `
    + `db=${result.dbTouched ? "yes" : "no"}, stateAge=${result.stateAgeSec}s`
  );
  return result;
}

/** Активные продажи из кэша (перечитывается при синхронизации) */
function activeSellForCheck(current: EcoState): SellTrackerRow[] {
  return current.sellTrackers.filter((s) => s.status === "active");
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

/** Статистика для админки: насколько экономно расходуется база */
export function getEcoStatus() {
  return {
    cached: !!state,
    stateAgeSec: state ? Math.round((Date.now() - state.loadedAt) / 1000) : null,
    syncSec: state ? Math.round(state.syncMs / 1000) : null,
    pendingWrites: pending.size,
    trackersCached: state?.trackers.length ?? 0,
  };
}
