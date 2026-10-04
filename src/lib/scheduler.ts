import { runTrackerCheck, getRuntimeConfig, getEcoStatus } from "./tracker-check";
import { pollTelegramUpdates } from "./telegram";

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRun: Date | null = null;
let lastSummary: string | null = null;
let started = false;
let ticks = 0;

/**
 * Фоновый планировщик.
 *
 * Раньше он читал настройки из базы на каждом тике — из-за этого Neon
 * никогда не засыпал и бесплатные CU-часы кончались к середине месяца.
 * Теперь конфиг берётся из кэша в памяти (tracker-check), а к базе
 * обращаемся только по расписанию синхронизации или когда найден новый лот.
 */
async function tick() {
  timer = null;
  if (!running) {
    running = true;
    try {
      const r = await runTrackerCheck("scheduler");
      ticks++;
      // Почту бота проверяем реже: привязка по кнопке на сайте работает мгновенно,
      // а фоновый опрос нужен лишь для тех, кто пишет боту напрямую.
      if (ticks % 5 === 0) await pollTelegramUpdates();
      lastRun = new Date();
      lastSummary =
        `трекеров: ${r.checked}, лотов EXBO: ${r.apiLots}, подходит: ${r.totalMatches}, `
        + `новых: ${r.matches.length}, TG: ${r.telegramSent}, ошибок: ${r.failed}, `
        + `база: ${r.dbTouched ? "запрос" : "спит"}`;
    } catch (e) {
      lastRun = new Date();
      lastSummary = `ошибка: ${String(e).slice(0, 120)}`;
    } finally {
      running = false;
    }
  }

  const { checkIntervalMs } = getRuntimeConfig();
  timer = setTimeout(tick, checkIntervalMs);
  timer.unref?.();
}

export async function ensureScheduler() {
  if (started) return;
  started = true;
  timer = setTimeout(tick, 5000); // небольшая задержка после старта сервера
  timer.unref?.();
}

export async function getSchedulerStatus() {
  const cfg = getRuntimeConfig();
  const eco = getEcoStatus();
  return {
    started,
    enabled: cfg.enabled,
    running,
    lastRun: lastRun ? lastRun.toISOString() : null,
    lastSummary,
    interval: Math.round(cfg.checkIntervalMs / 1000),
    eco,
  };
}
