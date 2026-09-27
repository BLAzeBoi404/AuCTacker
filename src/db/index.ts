import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// ВАЖНО: при сборке на Render env-переменных может ещё не быть,
// поэтому тут нельзя падать с throw — иначе build ляжет с
// "Error: DATABASE_URL is required" на сборе данных страниц.
// Подключение проверяется в момент реального запроса, а не импорта.
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn(
    "DATABASE_URL is not set — database queries will fail until it is configured."
  );
}

const fallbackUrl = "postgresql://postgres:postgres@127.0.0.1:5432/postgres";
const connectionString = databaseUrl || fallbackUrl;

// Neon требует SSL. Если в строке нет sslmode — добавляем.
// Локальному postgres это не мешает (ssl просто не используется без сервера с SSL).
const needsSsl =
  connectionString.includes("neon.tech") ||
  connectionString.includes("sslmode=require");

/**
 * УЧЁТ РАСХОДА NEON.
 *
 * Neon Free тарифицирует не запросы, а время, пока compute не спит.
 * Compute засыпает через 5 минут после последнего запроса. Значит:
 *   10 запросов за секунду  = одно «окно» = 5 минут работы
 *   10 запросов раз в час   = 10 «окон»  = 50 минут работы
 *
 * Поэтому считаем именно окна пробуждения — это и есть реальные CU-часы.
 * Статистика показывается в админке, чтобы видеть расход без похода в Neon.
 */
const IDLE_WINDOW_MS = 5 * 60 * 1000; // Neon scale-to-zero timeout

interface DbStats {
  queries: number;
  wakeWindows: number;
  lastQueryAt: number;
  startedAt: number;
}

const globalForDb = globalThis as typeof globalThis & {
  __auctrackerPool?: Pool;
  __auctrackerStats?: DbStats;
};

export const dbStats: DbStats = globalForDb.__auctrackerStats ?? {
  queries: 0,
  wakeWindows: 0,
  lastQueryAt: 0,
  startedAt: Date.now(),
};
globalForDb.__auctrackerStats = dbStats;

function noteQuery() {
  const now = Date.now();
  // Новое окно, только если предыдущее уже успело закрыться
  if (now - dbStats.lastQueryAt > IDLE_WINDOW_MS) dbStats.wakeWindows++;
  dbStats.lastQueryAt = now;
  dbStats.queries++;
}

function createPool() {
  const p = new Pool({
    connectionString,
    // Render Free + Neon: держим мало соединений, чтобы не упереться в лимит
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  // Оборачиваем query, чтобы считать каждое реальное обращение к Neon
  const originalQuery = p.query.bind(p);
   
  p.query = ((...args: any[]) => {
    noteQuery();
     
    return (originalQuery as any)(...args);
  }) as typeof p.query;

  return p;
}

export const pool = globalForDb.__auctrackerPool ?? createPool();

// Кэшируем всегда (и в prod тоже): иначе Next создаст пул на каждый импорт
// и Neon быстро скажет "too many connections".
globalForDb.__auctrackerPool = pool;

export const db = drizzle(pool);

/** Оценка расхода Neon по фактическим окнам пробуждения */
export function getDbUsage() {
  const uptimeMs = Math.max(1, Date.now() - dbStats.startedAt);
  const uptimeH = uptimeMs / 3_600_000;
  // Каждое окно = до 5 минут работы compute на минимальных 0.25 CU
  const cuHours = (dbStats.wakeWindows * (IDLE_WINDOW_MS / 3_600_000)) * 0.25;
  const perDay = uptimeH > 0 ? (cuHours / uptimeH) * 24 : 0;
  return {
    queries: dbStats.queries,
    wakeWindows: dbStats.wakeWindows,
    uptimeHours: Number(uptimeH.toFixed(2)),
    cuHoursUsed: Number(cuHours.toFixed(2)),
    cuHoursPerDay: Number(perDay.toFixed(2)),
    cuHoursPerMonth: Number((perDay * 30).toFixed(1)),
    limit: 100,
  };
}
