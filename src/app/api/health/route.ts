import { ensureScheduler } from "@/lib/scheduler";
import { ensureKeepAlive } from "@/lib/keep-alive";

export const dynamic = "force-dynamic";

/**
 * Проверка живости сервиса.
 *
 * Сюда регулярно стучится Render (healthCheckPath) и внешний пинг.
 * Поэтому здесь НЕТ запросов к базе: иначе каждый пинг будил бы Neon
 * и бесплатные CU-часы сгорали бы впустую.
 *
 * Заодно этот эндпоинт запускает планировщик и самопробуждение —
 * первый же пришедший запрос «поднимает» всю фоновую работу.
 */
export async function GET() {
  void ensureScheduler();
  void ensureKeepAlive();
  return Response.json({ ok: true, at: new Date().toISOString() });
}
