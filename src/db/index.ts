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

const globalForDb = globalThis as typeof globalThis & {
  __auctrackerPool?: Pool;
};

function createPool() {
  return new Pool({
    connectionString,
    // Render Free + Neon: держим мало соединений, чтобы не упереться в лимит
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

export const pool = globalForDb.__auctrackerPool ?? createPool();

// Кэшируем всегда (и в prod тоже): иначе Next создаст пул на каждый импорт
// и Neon быстро скажет "too many connections".
globalForDb.__auctrackerPool = pool;

export const db = drizzle(pool);
