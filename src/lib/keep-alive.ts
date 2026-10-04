import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * САМОПРОБУЖДЕНИЕ.
 *
 * Render Free усыпляет сайт после 15 минут без входящих запросов. Пока сайт
 * спит, встроенный планировщик не работает и уведомления не отправляются.
 *
 * Раньше решение сводилось к внешнему cron-job.org. Но если он не настроен
 * (или отвалился) — сайт просто молчал, и уведомления не уходили.
 * Теперь сервер сам пингует свой /api/health и не даёт себе уснуть.
 *
 * ВАЖНО ПРО БАЗУ: /api/health не обращается к базе, поэтому самопробуждение
 * не расходует CU-часы Neon. Планировщик ходит в базу только по расписанию.
 *
 * Состояние хранится в globalThis, а не в переменных модуля: Next.js собирает
 * разные бандлы для instrumentation и для роутов, и переменные модуля в них
 * независимы. Из-за этого таймер запускался в одном экземпляре, а статус
 * читался из другого и показывал «не работает».
 */
const SELF_PING_MS = 10 * 60 * 1000; // Render усыпляет после 15 минут — пингуем чаще

interface KeepAliveState {
  running: boolean;
  lastOk: number | null;
  lastFail: number | null;
  consecutiveFails: number;
  pings: number;
}

const globalThisRef = globalThis as typeof globalThis & {
  __auctrackerKeepAliveState?: KeepAliveState;
};

const state: KeepAliveState = globalThisRef.__auctrackerKeepAliveState ?? {
  running: false,
  lastOk: null,
  lastFail: null,
  consecutiveFails: 0,
  pings: 0,
};
globalThisRef.__auctrackerKeepAliveState = state;

async function ping(): Promise<void> {
  const port = process.env.PORT || "3000";
  const url = `http://127.0.0.1:${port}/api/health`;
  state.pings++;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.lastOk = Date.now();
    state.consecutiveFails = 0;
  } catch {
    state.lastFail = Date.now();
    state.consecutiveFails++;
    // После трёх неудач проверим базу — вдруг проблема в соединении
    if (state.consecutiveFails === 3) {
      try {
        await db.execute(sql`select 1`);
        console.warn("keep-alive: база отвечает, проблема была в локальном пинге");
      } catch (e) {
        console.error("keep-alive: база недоступна:", e instanceof Error ? e.message : e);
      }
    }
  }
}

/**
 * Запустить самопробуждение. Идемпотентно: повторный вызов ничего не делает.
 * Возвращает true, если таймер запущен этим вызовом.
 */
export function ensureKeepAlive(): boolean {
  if (state.running) return false;
  state.running = true;

  const timer = setInterval(() => {
    void ping();
  }, SELF_PING_MS);
  // Процесс держит alive HTTP-сервер, таймеру unref не мешает
  timer.unref?.();

  // Первый пинг сразу — фиксируем, что сервис жив
  void ping();
  console.log(`Keep-alive started: self-ping every ${SELF_PING_MS / 1000}s`);
  return true;
}

export function getKeepAliveStatus() {
  return {
    running: state.running,
    intervalSec: SELF_PING_MS / 1000,
    lastOk: state.lastOk ? new Date(state.lastOk).toISOString() : null,
    lastFail: state.lastFail ? new Date(state.lastFail).toISOString() : null,
    consecutiveFails: state.consecutiveFails,
    pings: state.pings,
  };
}
