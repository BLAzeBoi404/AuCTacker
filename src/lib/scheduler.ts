import { getSetting, setSetting } from "./settings";
import { runTrackerCheck } from "./tracker-check";
import { pollTelegramUpdates } from "./telegram";
import { syncItemsFromGithub } from "./exbo";

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRun: Date | null = null;
let lastSummary: string | null = null;
let started = false;
let nextRunAt: Date | null = null;

const ITEM_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // раз в 6 часов

// Раз в несколько часов подтягиваем свежий список предметов из
// stalzone-database — если разработчики добавили в игру новый предмет,
// он появится в каталоге сайта сам, без ручного нажатия "Обновить базу".
async function maybeSyncItems() {
  try {
    const lastRaw = await getSetting("items_last_sync_at");
    const last = lastRaw ? Number(lastRaw) : 0;
    if (Date.now() - last < ITEM_SYNC_INTERVAL_MS) return;
    const r = await syncItemsFromGithub();
    await setSetting("items_last_sync_at", String(Date.now()));
    console.log(`[scheduler] каталог предметов обновлён: ${r.count}`);
  } catch (e) {
    console.error("[scheduler] item sync failed:", e);
  }
}

// Встроенный планировщик: проверяет трекеры, почту Telegram-бота и раз в
// несколько часов — свежий список предметов. Работает, пока запущен сервер.
// Безопасно дублируется внешним cron-пингом (см. /api/cron/check).
async function tick() {
  timer = null;
  try {
    const enabled = ((await getSetting("scheduler_enabled")) ?? "1") === "1";
    if (enabled && !running) {
      running = true;
      try {
        const r = await runTrackerCheck("scheduler");
        await pollTelegramUpdates();
        void maybeSyncItems(); // не блокирует основной цикл проверки трекеров
        lastRun = new Date();
        lastSummary = `проверено: ${r.checked}, новых: ${r.matches.length}, TG: ${r.telegramSent}`;
      } catch (e) {
        lastRun = new Date();
        lastSummary = `ошибка: ${String(e).slice(0, 120)}`;
      } finally {
        running = false;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    // По умолчанию 10 минут — это безопасный интервал для бесплатного плана
    // Neon (100 CU-часов/мес): база успевает "заснуть" (scale-to-zero через
    // 5 минут простоя) между проверками, а не работает непрерывно.
    // Подробный расчёт — в Настройках сайта и в HOSTING.md.
    const iv = Math.min(
      3600,
      Math.max(30, Number((await getSetting("scheduler_interval")) || 600))
    );
    nextRunAt = new Date(Date.now() + iv * 1000);
    timer = setTimeout(tick, iv * 1000);
    timer.unref?.();
  } catch {
    nextRunAt = new Date(Date.now() + 600000);
    timer = setTimeout(tick, 600000);
    timer.unref?.();
  }
}

export async function ensureScheduler() {
  if (started) return;
  started = true;
  nextRunAt = new Date(Date.now() + 5000);
  timer = setTimeout(tick, 5000); // небольшая задержка после старта сервера
  timer.unref?.();
}

export async function getSchedulerStatus() {
  const enabled = ((await getSetting("scheduler_enabled")) ?? "1") === "1";
  const interval = Math.min(
    3600,
    Math.max(30, Number((await getSetting("scheduler_interval")) || 600))
  );
  return {
    started,
    enabled,
    running,
    lastRun: lastRun ? lastRun.toISOString() : null,
    lastSummary,
    interval,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
  };
}
