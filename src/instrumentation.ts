// Автозапуск фонового планировщика вместе с сервером (next start)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { ensureScheduler } = await import("./lib/scheduler");
      await ensureScheduler();
    } catch (e) {
      console.error("scheduler start failed:", e);
    }
  }
}
