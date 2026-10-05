// Автозапуск фоновой работы вместе с сервером (next start).
//
// Во время `next build` ничего не делаем: там нет базы, а таймеры не нужны.
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Защита от падения процесса.
  // Node по умолчанию убивает процесс при необработанном отказе промиса
  // и при необработанной ошибке — после чего сайт перестаёт отвечать
  // до самого следующего деплоя. Для долгоживущего сервиса, который
  // обязан принимать уведомления круглосуточно, это недопустимо:
  // логируем ошибку и продолжаем работу.
  if (!process.env.__AUCTRACKER_GUARDS) {
    process.env.__AUCTRACKER_GUARDS = "1";

    process.on("unhandledRejection", (reason) => {
      console.error(
        "[auctacker] необработанный отказ промиса (процесс продолжает работать):",
        reason instanceof Error ? reason.message : reason
      );
    });

    process.on("uncaughtException", (err) => {
      console.error(
        "[auctacker] необработанное исключение (процесс продолжает работать):",
        err
      );
    });
  }

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
