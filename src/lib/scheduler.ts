import { getSetting } from "./settings";
import { runTrackerCheck } from "./tracker-check";
import { pollTelegramUpdates } from "./telegram";

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRun: Date | null = null;
let lastSummary: string | null = null;
let started = false;

// Встроенный планировщик: проверяет трекеры и почту Telegram-бота,
// пока запущен сервер. Безопасно дублируется внешним cron-пингом.
async function tick() {
  timer = null;
  try {
    const enabled = ((await getSetting("scheduler_enabled")) ?? "1") === "1";
    if (enabled && !running) {
      running = true;
      try {
        const r = await runTrackerCheck("scheduler");
        await pollTelegramUpdates();
        lastRun = new Date();
        lastSummary = `проверено: ${r.checked}, EXBO-лотов: ${r.apiLots}, совпадений: ${r.totalMatches}, новых: ${r.matches.length}, TG: ${r.telegramSent}, ошибок: ${r.failed}`;
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
    const iv = Math.min(
      3600,
      Math.max(15, Number((await getSetting("scheduler_interval")) || 60))
    );
    timer = setTimeout(tick, iv * 1000);
    timer.unref?.();
  } catch {
    timer = setTimeout(tick, 60000);
    timer.unref?.();
  }
}

export async function ensureScheduler() {
  if (started) return;
  started = true;
  timer = setTimeout(tick, 5000); // небольшая задержка после старта сервера
  timer.unref?.();
}

export async function getSchedulerStatus() {
  const enabled = ((await getSetting("scheduler_enabled")) ?? "1") === "1";
  const interval = Math.min(
    3600,
    Math.max(15, Number((await getSetting("scheduler_interval")) || 60))
  );
  return {
    started,
    enabled,
    running,
    lastRun: lastRun ? lastRun.toISOString() : null,
    lastSummary,
    interval,
  };
}
