import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getSetting } from "./settings";

/**
 * САМОПРОБУЖДЕНИЕ.
 *
 * Render Free усыпляет сервис через 15 минут без входящих запросов. Пока он
 * спит, встроенный планировщик не работает и уведомления не уходят.
 *
 * Ключевой момент: пинг ОБЯЗАН идти через публичный адрес, а не на 127.0.0.1.
 * Запрос на localhost никуда не выходит из контейнера, балансировщик его не
 * видит, счётчик бездействия Render не сбрасывается — и сервис всё равно
 * усыпается. Именно это и было причиной «сайт отрубается сам по себе».
 *
 * Публичный адрес берётся по приоритету:
 *   1. переменная RENDER_EXTERNAL_URL (Render задаёт её сам);
 *   2. «Адрес сайта» из настроек админки;
 *   3. localhost — крайний случай, пинг есть, но Render его не видит.
 *
 * Сам ping вызывает сам Render: при уснувшем сервисе запрос пробуждает его
 * (холодный старт ~60 с), поэтому сервис получается самовосстанавливающимся.
 *
 * РАСХОД БАЗЫ: /api/health не обращается к базе, поэтому самопробуждение
 * не тратит CU-часы Neon.
 */
const SELF_PING_MS = 10 * 60 * 1000; // Render усыпает через 15 минут — с запасом
const PING_TIMEOUT_MS = 75_000;       // холодный старт на Render занимает до ~60 с

interface KeepAliveState {
  running: boolean;
  lastOk: number | null;
  lastFail: number | null;
  consecutiveFails: number;
  pings: number;
  target: string;
  targetKind: "render" | "settings" | "localhost";
  wakeups: number;
  resolvedAt: number;
}

const g = globalThis as typeof globalThis & {
  __auctrackerKeepAliveState?: KeepAliveState;
};

const state: KeepAliveState = g.__auctrackerKeepAliveState ?? {
  running: false,
  lastOk: null,
  lastFail: null,
  consecutiveFails: 0,
  pings: 0,
  target: "",
  targetKind: "localhost",
  wakeups: 0,
  resolvedAt: 0,
};
g.__auctrackerKeepAliveState = state;

let inFlight = false;

// Результат кэшируем: чтение site_url обошлось бы запросом к базе на каждом
// пинге. На Render база вообще не нужна — адрес берётся из переменной окружения.
const TARGET_TTL_MS = 30 * 60 * 1000;

/** Определяем адрес, который балансировщик Render реально видит */
async function resolveTarget(): Promise<{ url: string; kind: KeepAliveState["targetKind"] }> {
  if (state.target && Date.now() - state.resolvedAt < TARGET_TTL_MS) {
    return { url: state.target, kind: state.targetKind };
  }

  let resolved: { url: string; kind: KeepAliveState["targetKind"] };

  // 1. Render задаёт публичный адрес веб-сервиса сам — самый надёжный вариант.
  // Если по какой-то причине полноценного URL нет — собираем из хостнейма.
  const renderUrl =
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    (process.env.RENDER_EXTERNAL_HOSTNAME?.trim()
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME.trim()}`
      : "");
  if (renderUrl) {
    resolved = { url: `${renderUrl.replace(/\/$/, "")}/api/health`, kind: "render" };
  } else {
    // 2. Адрес, указанный админом
    let configured = "";
    try {
      configured = ((await getSetting("site_url")) || "").trim();
    } catch {
      // база недоступна — попробуем в следующий раз
    }
    if (configured) {
      resolved = { url: `${configured.replace(/\/$/, "")}/api/health`, kind: "settings" };
    } else {
      // 3. Локально: работает на своём ПК, но Render такой пинг не считает
      const port = process.env.PORT || "3000";
      resolved = { url: `http://127.0.0.1:${port}/api/health`, kind: "localhost" };
    }
  }

  state.target = resolved.url;
  state.targetKind = resolved.kind;
  state.resolvedAt = Date.now();
  if (resolved.kind !== "localhost") {
    console.log(`Keep-alive target: ${resolved.url} (${resolved.kind})`);
  } else {
    console.warn("Keep-alive: публичный адрес неизвестен, пинг идёт на localhost (Render не увидит)");
  }
  return resolved;
}

async function ping(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  state.pings++;
  try {
    const { url, kind } = await resolveTarget();
    state.target = url;
    state.targetKind = kind;

    const res = await fetch(url, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Ранее сервис спал и только что проснулся — зафиксировали пробуждение
    if (state.consecutiveFails > 0 || (state.lastFail && Date.now() - state.lastFail > 10 * 60 * 1000)) {
      state.wakeups++;
    }
    state.lastOk = Date.now();
    state.consecutiveFails = 0;
  } catch {
    state.lastFail = Date.now();
    state.consecutiveFails++;
    // После трёх отказов проверим базу: вдруг сервис жив, а упала только связь
    if (state.consecutiveFails === 3) {
      try {
        await db.execute(sql`select 1`);
        console.warn("keep-alive: база отвечает, падал только HTTP-пинг");
      } catch (e) {
        console.error("keep-alive: база недоступна:", e instanceof Error ? e.message : e);
      }
    }
  } finally {
    inFlight = false;
  }
}

/** Запустить самопробуждение. Идемпотентно. */
export function ensureKeepAlive(): boolean {
  if (state.running) return false;
  state.running = true;

  const timer = setInterval(() => {
    void ping();
  }, SELF_PING_MS);
  timer.unref?.();

  // Первый пинг — после того, как сервер успеет дослушать порт и поднять
  // планировщик. Иначе он ловит «connection refused» и ставит ложную неудачу.
  setTimeout(() => {
    void ping();
  }, 20_000).unref?.();
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
    target: state.target,
    targetKind: state.targetKind,
    wakeups: state.wakeups,
    // true, пока адрес не разрешён — чтобы не показывать ложное
    // предупреждение «Render не видит» до первого пинга
    visibleToRender: state.resolvedAt > 0 ? state.targetKind !== "localhost" : true,
  };
}
