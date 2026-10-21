// Автозапуск фоновой работы вместе с сервером (next start).
//
// Во время `next build` ничего не делаем: там нет базы, а таймеры не нужны.
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.AUCTRACKER_BACKGROUND === "0") return;

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
  try {
    const { ensureKeepAlive } = await import("./lib/keep-alive");
    ensureKeepAlive();
  } catch (e) {
    console.error("keep-alive start failed:", e);
  }
}
