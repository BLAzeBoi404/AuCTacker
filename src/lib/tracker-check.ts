import { db } from "@/db";
import { trackers, notifications, sellTrackers } from "@/db/schema";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { fetchHistoryAll, fetchLotsAll, type NormalizedLot } from "./exbo";
import { QUALITY_NAMES } from "./constants";
import { getSetting } from "./settings";
import { getActiveChats, sendTelegramMessage, esc } from "./telegram";
import { invalidateAll } from "./user-cache";
import { buyLotMatches, sellLotMatches, decideMissingSale, SALE_GRACE_MS } from "./tracker-rules";
import { ensureSchema } from "./ensure-schema";

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
let nextDeliveryAt = 0;
let stateVersion = 0;

/** Отложенные записи: копятся в памяти, уходят в базу одной пачкой */
interface PendingWrite {
  matchCount?: number;
  lastMatchedAt?: Date | null;
  lastSeenLotIds: string[];
  /** null — трекер ещё ни разу не проверялся успешно (базовый снимок не снят) */
  lastCheckedAt: Date | null;
  lastResultCount: number;
  lastApiTotal: number;
  lastError: string | null;
}
const pending = new Map<number, PendingWrite>();

/** Отложенные отметки продаж: last_seen_at + miss_count без пробуждения базы */
type PendingSellWrite = Partial<Pick<SellTrackerRow,
  "lastSeenAt" | "missCount" | "firstMissingAt" | "lastCheckedAt" | "lastError"
  | "targetLotId" | "expectedEndTime" | "startTime" | "quality" | "upgrade" | "price" | "amount" | "qualityName"
>>;
const pendingSell = new Map<number, PendingSellWrite>();

/** Сбросить кэш — вызывается при создании/изменении/удалении трекера */
export function invalidateTrackerCache(): void {
  state = null;
  stateVersion++;
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
          ...w,
          lastSeenLotIds: w.lastSeenLotIds.slice(0, 2000),
          lastCheckedAt: w.lastCheckedAt,
          lastResultCount: w.lastResultCount,
          lastApiTotal: w.lastApiTotal,
          lastError: w.lastError,
        }).where(eq(trackers.id, id));
        wrote = true;
      } catch (e) {
        if (!pending.has(id)) pending.set(id, w);
        console.error("flushPending failed for tracker", id, e);
      }
    }
  }
  if (pendingSell.size > 0) {
    const entries = [...pendingSell.entries()];
    pendingSell.clear();
    for (const [id, w] of entries) {
      try {
        await db.update(sellTrackers).set(w).where(and(eq(sellTrackers.id, id), eq(sellTrackers.status, "active")));
        wrote = true;
      } catch (e) {
        if (!pendingSell.has(id)) pendingSell.set(id, w);
        console.error("flushPending failed for sell tracker", id, e);
      }
    }
  }
  return wrote;
}

async function loadState(): Promise<EcoState> {
  await ensureSchema();
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
      sql`delete from notifications where id in (
        select id from (
          select id, row_number() over (partition by owner_key order by created_at desc, id desc) as position
          from notifications where sent_at is not null
        ) old where position > 300
      )`
    );
  } catch {
    /* очистка не должна ломать проверку */
  }

  hasPendingDeliveries = true; // после перезапуска проверим неотправленные
  nextDeliveryAt = 0;
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

async function fetchAllLots(itemId: string, region: string) {
  return fetchLotsAll(itemId, region, 2000);
}

/** Дослать уведомления, которые не ушли с первой попытки */
async function deliverPending(chats: ChatRow[], siteUrl: string): Promise<number> {
  const rows = await db.select().from(notifications).where(and(
    isNull(notifications.sentAt),
    lte(notifications.retryAt, new Date()),
    gt(notifications.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
  )).orderBy(asc(notifications.id)).limit(20);

  if (rows.length === 0) {
    const [waiting] = await db.select({ retryAt: notifications.retryAt }).from(notifications).where(and(
      isNull(notifications.sentAt), gt(notifications.createdAt, new Date(Date.now() - 86_400_000)),
    )).orderBy(asc(notifications.retryAt)).limit(1);
    hasPendingDeliveries = !!waiting;
    nextDeliveryAt = waiting?.retryAt?.getTime() ?? 0;
    return 0;
  }

  let delivered = 0;
  for (const notification of rows) {
    // Досылаем только тем чатам, кому это уведомление адресовано.
    // Если адресатов нет — помечаем как доставленное и больше не трогаем.
    const requested = Array.isArray(notification.targetChatIds)
      ? notification.targetChatIds.filter((chatId) =>
          chats.some((chat) => chat.chatId === chatId && chat.ownerKey === notification.ownerKey),
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
            + `${esc(notification.qualityName || "Неизвестна")} • ${notification.upgrade >= 0 ? `+${notification.upgrade}` : "заточка неизвестна"}\n`
            + `Регион: ${esc(notification.region)}\n`
            + `Можно забирать деньги с аукциона.`
          : kind === "sell_removed"
            ? `ℹ️ <b>Лот исчез: ${esc(notification.itemName)}</b>\n\n`
              + `Лота больше нет в выдаче аукциона. EXBO не подтвердил продажу. Проверьте результат в игре.\n`
              + `Регион: ${esc(notification.region)}`
          : kind === "sell_expired"
            ? `⌛ <b>Срок лота истёк: ${esc(notification.itemName)}</b>\n\n`
              + `Цена была: <b>${notification.price.toLocaleString("ru-RU")} ₽</b>\n`
              + `${esc(notification.qualityName || "Неизвестна")} • ${notification.upgrade >= 0 ? `+${notification.upgrade}` : "заточка неизвестна"}\n`
              + `Регион: ${esc(notification.region)}\n`
              + `Срок лота прошёл; подтверждение продажи в доступной истории не найдено. Проверьте аукцион в игре.`
            : `🎯 <b>Новый лот: ${esc(notification.itemName)}</b>\n\n`
              + `Цена: <b>${notification.price.toLocaleString("ru-RU")} ₽</b>\n`
              + `${esc(notification.qualityName || "Неизвестна")} • ${notification.upgrade >= 0 ? `+${notification.upgrade}` : "заточка неизвестна"}\n`
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
    const version = stateVersion;
    current = await loadState();
    if (version === stateVersion) state = current;
    result.dbTouched = true;
  }
  result.stateAgeSec = Math.round((Date.now() - current.loadedAt) / 1000);

  if (!current.schedulerEnabled && source !== "manual") return result;

  const chatsByOwner = new Map<string, ChatRow[]>();
  for (const chat of current.chats) {
    if (!chat.ownerKey) continue;
    chatsByOwner.set(chat.ownerKey, [...(chatsByOwner.get(chat.ownerKey) || []), chat]);
  }

  const enabled = current.trackers.filter((tracker) => tracker.enabled);
  const activeSell = current.sellTrackers.filter((s) => s.status === "active");

  // Снимки аукциона кэшируем в пределах одного цикла: один предмет+регион —
  // один набор запросов к EXBO, сколько бы трекеров (покупки + продажи) его ни смотрели
  const snapshots = new Map<string, Awaited<ReturnType<typeof fetchAllLots>>>();
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

      const matching = snapshot.lots.filter((lot) => buyLotMatches(lot, tracker));

      result.checked++;
      result.totalMatches += matching.length;
      if (firstRun) result.initialized++;

      // Стартовый отчёт — один раз на трекер
      let reportSent = tracker.initialReportSent;
      if (!reportSent && targets.length) {
        const quality = tracker.targetQuality === -1 ? "любая редкость" : `${QUALITY_NAMES[tracker.targetQuality]}${tracker.qualityMode === "min" ? " и выше" : ""}`;
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
          try {
            await db.update(trackers).set({ initialReportSent: true }).where(eq(trackers.id, tracker.id));
            tracker.initialReportSent = true;
            result.dbTouched = true;
          } catch { /* повторим в следующий раз */ }
        }
      }

      // 3. Новые лоты — единственный случай, когда база нужна немедленно
      let newCount = 0;
      const failedIds = new Set<string>();
      if (!firstRun) {
        for (const lot of matching) {
          if (seen.has(lot.id) || (lot.legacyId && seen.has(lot.legacyId))) continue;
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
            qualityName: QUALITY_NAMES[lot.quality] || "Неизвестна",
            endTime: lot.endTime,
            isNew: true,
          };
          try {
            const inserted = await db.insert(notifications).values({
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
              message: `${lot.upgrade >= 0 ? `+${lot.upgrade}` : "заточка неизвестна"} • ${match.qualityName} • ${price.toLocaleString("ru-RU")} ₽`,
              targetChatIds: targets.map((target) => target.chatId),
              sentChatIds: [],
              retryAt: new Date(),
            }).onConflictDoNothing().returning({ id: notifications.id });
            if (inserted.length) { result.matches.push(match); newCount++; }
            result.dbTouched = true;
            hasPendingDeliveries = true;
            nextDeliveryAt = 0;
            invalidateAll(); // у пользователя появилось новое уведомление
          } catch (e) {
            failedIds.add(lot.id);
            console.error("notification insert failed:", e);
          }
        }
      }

      // Обновляем состояние в памяти
      tracker.lastSeenLotIds = [...new Set([...seen, ...currentIds])].filter((id) => !failedIds.has(id)).slice(-2000);
      tracker.lastCheckedAt = new Date();
      tracker.lastResultCount = matching.length;
      tracker.lastApiTotal = snapshot.total;
      tracker.lastError = failedIds.size ? "Не удалось сохранить часть уведомлений. Повторим проверку." : null;
      if (failedIds.size) result.failed++;
      if (newCount) {
        tracker.matchCount += newCount;
        tracker.lastMatchedAt = new Date();
      }

      if (firstRun || newCount) {
        // Начальный снимок тоже сохраняем: перезапуск не должен заново
        // инициализировать трекер и пропускать появившиеся за это время лоты.
        try {
          await db.update(trackers).set({
            lastSeenLotIds: tracker.lastSeenLotIds,
            lastCheckedAt: tracker.lastCheckedAt,
            lastResultCount: tracker.lastResultCount,
            lastApiTotal: tracker.lastApiTotal,
            lastError: tracker.lastError,
            matchCount: tracker.matchCount,
            lastMatchedAt: tracker.lastMatchedAt,
          }).where(eq(trackers.id, tracker.id));
          pending.delete(tracker.id);
          result.dbTouched = true;
        } catch (e) {
          pending.set(tracker.id, {
            lastSeenLotIds: tracker.lastSeenLotIds, lastCheckedAt: tracker.lastCheckedAt,
            lastResultCount: tracker.lastResultCount, lastApiTotal: tracker.lastApiTotal,
            lastError: tracker.lastError, matchCount: tracker.matchCount, lastMatchedAt: tracker.lastMatchedAt,
          });
          console.error("tracker update failed:", e);
        }
      } else {
        // Ничего нового — откладываем запись, база продолжает спать
        pending.set(tracker.id, {
          lastSeenLotIds: tracker.lastSeenLotIds,
          lastCheckedAt: tracker.lastCheckedAt,
          lastResultCount: tracker.lastResultCount,
          lastApiTotal: tracker.lastApiTotal,
          lastError: tracker.lastError,
        });
      }
    }
  }

  // 4. Проверяем конкретные лоты. Неполная выдача и ошибки API не являются
  // исчезновением лота. История для одного предмета загружается один раз за цикл.
  const histories = new Map<string, Promise<Awaited<ReturnType<typeof fetchHistoryAll>>>>();
  result.sellChecked = activeSell.length;
  for (const sell of activeSell) {
    try {
      const snap = await getSnapshot(sell.region, sell.itemId);
      const now = Date.now();
      const found = snap.lots.find((lot) => sellLotMatches(lot, sell));
      const foundEnd = found?.endTime ? new Date(found.endTime) : sell.expectedEndTime;
      const stillLive = found && (!foundEnd || now < foundEnd.getTime() + SALE_GRACE_MS);
      if (stillLive) {
        const wasMissing = sell.missCount > 0 || sell.firstMissingAt !== null;
        const patch: PendingSellWrite = {
          targetLotId: found.id, lastSeenAt: new Date(now), lastCheckedAt: new Date(now),
          expectedEndTime: foundEnd, startTime: found.startTime ? new Date(found.startTime) : sell.startTime,
          quality: found.quality, upgrade: found.upgrade, price: found.buyoutPrice || found.startPrice,
          amount: found.amount, qualityName: QUALITY_NAMES[found.quality] || "Неизвестна",
          missCount: 0, firstMissingAt: null, lastError: null,
        };
        Object.assign(sell, patch);
        pendingSell.set(sell.id, { ...pendingSell.get(sell.id), ...patch });
        if (wasMissing) {
          await db.update(sellTrackers).set(patch).where(and(eq(sellTrackers.id, sell.id), eq(sellTrackers.status, "active")));
          pendingSell.delete(sell.id);
          invalidateAll();
          result.dbTouched = true;
        }
        continue;
      }
      if (!snap.complete && (!sell.expectedEndTime || now < sell.expectedEndTime.getTime() + SALE_GRACE_MS)) {
        const patch = { lastCheckedAt: new Date(now), lastError: "Выдача EXBO неполная. Статус лота пока не меняем." };
        Object.assign(sell, patch);
        pendingSell.set(sell.id, { ...pendingSell.get(sell.id), ...patch });
        continue;
      }
      const firstMiss = sell.missCount === 0;
      sell.missCount++;
      sell.firstMissingAt ??= new Date(now);
      sell.lastCheckedAt = new Date(now);
      sell.lastError = null;
      pendingSell.set(sell.id, { ...pendingSell.get(sell.id), missCount: sell.missCount,
        firstMissingAt: sell.firstMissingAt, lastCheckedAt: sell.lastCheckedAt, lastError: null });
      if (firstMiss) {
        // Сохраняем переход сразу: сон/перезапуск сервера не должен обнулять
        // время исчезновения и оставлять лот активным навсегда.
        await db.update(sellTrackers).set(pendingSell.get(sell.id)!).where(and(eq(sellTrackers.id, sell.id), eq(sellTrackers.status, "active")));
        pendingSell.delete(sell.id);
        invalidateAll();
        result.dbTouched = true;
      }
      if (sell.missCount < 2) continue;

      let hist: Awaited<ReturnType<typeof fetchHistoryAll>> | null = null;
      const key = `${sell.region}|${sell.itemId}`;
      try {
        if (!histories.has(key)) histories.set(key, fetchHistoryAll(sell.itemId, sell.region, 2000));
        hist = await histories.get(key)!;
      } catch { /* временно оставляем статус неопределённым */ }
      const since = Math.max(sell.createdAt?.getTime() ?? 0, sell.lastSeenAt?.getTime() ?? 0) - 5000;
      const coversPeriod = !!hist && (hist.complete || hist.history.some((h) => h.time && Date.parse(h.time) <= since));
      const decision = decideMissingSale(sell, hist?.history ?? null, coversPeriod, now);
      if (!decision) continue;
      const { status, finishedAt, price } = decision;
      const qualityName = sell.qualityName || QUALITY_NAMES[sell.quality] || "Неизвестна";
      // Статус и уведомление сохраняем атомарно: повторный запуск не потеряет
      // уведомление и не создаст второе для уже завершённой продажи.
      const changed = await db.transaction(async (tx) => {
        const updated = await tx.update(sellTrackers).set({
          status, finishedAt, finishPrice: price, missCount: sell.missCount,
          firstMissingAt: sell.firstMissingAt, lastCheckedAt: sell.lastCheckedAt, lastError: null,
        }).where(and(eq(sellTrackers.id, sell.id), eq(sellTrackers.status, "active"))).returning({ id: sellTrackers.id });
        if (!updated.length) return false;
        await tx.insert(notifications).values({
          kind: `sell_${status}`, ownerKey: sell.ownerKey, trackerId: null,
          itemId: sell.itemId, itemName: sell.itemName, itemIcon: sell.itemIcon,
          region: sell.region, lotId: sell.targetLotId, price: price ?? sell.price,
          upgrade: sell.upgrade, quality: sell.quality, qualityName,
          message: status === "sold" ? `Продан за ${sell.price.toLocaleString("ru-RU")} ₽`
            : status === "expired" ? "Срок лота истёк; продажа в доступной истории не найдена"
            : "Лот исчез. Продажа не подтверждена — проверьте результат в игре",
          targetChatIds: (sell.ownerKey ? (chatsByOwner.get(sell.ownerKey) || []) : []).map((chat) => chat.chatId),
          sentChatIds: [], retryAt: new Date(),
        });
        return true;
      });
      sell.status = status;
      sell.finishedAt = finishedAt;
      pendingSell.delete(sell.id);
      if (changed) {
        if (status === "sold") result.sellSold++;
        else if (status === "expired") result.sellExpired++;
        hasPendingDeliveries = true;
        nextDeliveryAt = 0;
        invalidateAll();
        result.dbTouched = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "EXBO EAPI недоступен";
      sell.lastError = message;
      pendingSell.set(sell.id, { ...pendingSell.get(sell.id), lastError: message });
      result.failed++;
      result.errors.push(`${sell.itemName}: ${message}`);
      console.error("sell tracker check failed:", sell.id, message);
    }
  }

  // 5. Досылка застрявших уведомлений — только если есть что досылать
  if (current.telegramEnabled && hasPendingDeliveries && Date.now() >= nextDeliveryAt) {
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

export function liveTrackerRows<T extends { id: number }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, ...pending.get(row.id) }));
}

export function liveSellRows<T extends { id: number }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, ...pendingSell.get(row.id) }));
}
