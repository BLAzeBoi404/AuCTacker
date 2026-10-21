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
import { AsyncCache } from "./async-cache";

const store = new AsyncCache(60_000, 500);

export async function cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
  return store.get(key, loader) as Promise<T>;
}

/** Сбросить записи профиля (после создания/изменения/удаления) */
export function invalidateOwner(ownerKey: string): void {
  store.invalidate((key) => key.endsWith(`:${ownerKey}`));
}

/** Сбросить всё (после фоновой проверки, которая могла создать уведомления) */
export function invalidateAll(): void {
  store.invalidate();
}

export function userCacheSize(): number {
  return store.size;
}
