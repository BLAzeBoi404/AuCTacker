import { ensureScheduler } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

/**
 * Проверка живости сервиса.
 *
 * Сюда регулярно стучится Render (healthCheckPath) и внешний пинг.
 * Поэтому здесь НЕТ запросов к базе: иначе каждый пинг будил бы Neon
 * и бесплатные CU-часы сгорали бы впустую.
 *
 * Состояние базы смотрите в админке — там есть реальная статистика.
 */
export async function GET() {
  void ensureScheduler();
  return Response.json({ ok: true, at: new Date().toISOString() });
}
