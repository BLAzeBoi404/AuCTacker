export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е")
    .replace(/[«»“”"']/g, "").replace(/\s+/g, " ").trim();
}

export function searchRank(item: { id: string; nameRu?: string | null; nameEn?: string | null; name?: string }, query: string): number {
  const q = normalizeSearch(query);
  if (item.id === query.trim()) return 0;
  const names = [item.nameRu || item.name || "", item.nameEn || ""].map(normalizeSearch);
  if (names.includes(q)) return 1;
  if (names.some((s) => s.startsWith(q))) return 2;
  if (names.some((s) => s.includes(q))) return 3;
  return 4;
}
