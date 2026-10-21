interface Entry<T> {
  value?: T;
  expiresAt: number;
  promise?: Promise<T>;
}

/** Ограниченный кэш: параллельные читатели разделяют один запрос. */
export class AsyncCache<T = unknown> {
  private entries = new Map<string, Entry<T>>();

  constructor(private ttlMs: number, private maxEntries: number) {}

  get(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit?.promise) return hit.promise;
    if (hit && Date.now() < hit.expiresAt) return Promise.resolve(hit.value as T);
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    const entry: Entry<T> = { expiresAt: 0 };
    entry.promise = Promise.resolve().then(loader).then((value) => {
      // Запись могли сбросить, пока запрос выполнялся: не возвращаем старые данные в кэш.
      if (this.entries.get(key) === entry) {
        entry.value = value;
        entry.expiresAt = Date.now() + this.ttlMs;
        entry.promise = undefined;
      }
      return value;
    }, (error) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  invalidate(predicate?: (key: string) => boolean): void {
    if (!predicate) this.entries.clear();
    else for (const key of this.entries.keys()) if (predicate(key)) this.entries.delete(key);
  }

  get size(): number { return this.entries.size; }
}
