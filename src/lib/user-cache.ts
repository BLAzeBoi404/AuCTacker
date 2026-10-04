/**
 * КЭШ ПОЛЬЗОВАТЕЛЬСКИХ ДАННЫХ.
 *
 * Трекеры и уведомления читаются при каждом открытии сайта и переключении
 * вкладок. Без кэша каждое такое действие будило Neon: пять друзей, листающих
 * страницы, держали базу в тонусе и жгли бесплатные CU-часы.
 *
 * Данные небольшие и меняются редко, поэтому держим их в памяти на короткое
 * время и сбрасываем сразу при любой записи — пользователь всегда видит
 * актуальное состояние, а база спит.
 */
const TTL_MS = 60_000;

interface Entry<T> {
  value: T;
  exp: number;
}

const store = new Map<string, Entry<unknown>>();

export async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() < hit.exp) return hit.value as T;
  const value = await loader();
  store.set(key, { value, exp: Date.now() + TTL_MS });
  return value;
}

/** Сбросить записи профиля (после создания/изменения/удаления) */
export function invalidateOwner(ownerKey: string): void {
  for (const key of store.keys()) {
    if (key.endsWith(`:${ownerKey}`)) store.delete(key);
  }
}

/** Сбросить всё (после фоновой проверки, которая могла создать уведомления) */
export function invalidateAll(): void {
  store.clear();
}

export function userCacheSize(): number {
  return store.size;
}
