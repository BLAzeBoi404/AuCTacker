// Автозапуск вместе с сервером (next start):
// 1) создаём таблицы, если их нет (первый деплой на Neon),
// 2) запускаем фоновый планировщик трекеров.
//
// Во время `next build` (NEXT_PHASE=phase-production-build) ничего не делаем:
// коннекта к базе на сборке может не быть, а таймеры там не нужны.
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureSchema } = await import("./lib/ensure-schema");
      await ensureSchema();
    } catch (e) {
      console.error("schema ensure failed:", e);
    }
    try {
      const { ensureScheduler } = await import("./lib/scheduler");
      await ensureScheduler();
    } catch (e) {
      console.error("scheduler start failed:", e);
    }
  }
}
