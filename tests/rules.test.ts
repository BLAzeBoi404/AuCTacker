import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLot, normalizeHistory, parseAdditional } from "../src/lib/auction-data";
import { buyLotMatches, sellLotMatches, decideMissingSale, type BuyConditions, type SellConditions } from "../src/lib/tracker-rules";
import { normalizeSearch, searchRank } from "../src/lib/search";
import { boundedInt, trackerConditionsError } from "../src/lib/validation";
import { AsyncCache } from "../src/lib/async-cache";

const now = Date.parse("2026-10-21T12:00:00Z");
const lot = normalizeLot({ id: "mine", price: 3_000_000_000, amount: 2,
  startTime: "2026-10-20T12:00:00Z", endTime: "2026-10-21T11:00:00Z", additional: { qlt: 4, ptn: 10 } }, "AbC");
const buy: BuyConditions = { targetQuality: 3, qualityMode: "min", upgradeMode: "min", targetUpgrade: 5, minPrice: 0, maxPrice: 0 };
const sell: SellConditions = { targetLotId: "mine", price: lot.buyoutPrice, amount: 2, quality: 4, upgrade: 10,
  expectedEndTime: new Date(lot.endTime!), createdAt: new Date("2026-10-20T12:00:00Z"),
  lastSeenAt: new Date("2026-10-21T10:00:00Z"), firstMissingAt: new Date("2026-10-21T10:05:00Z"), missCount: 2 };
const sale = normalizeHistory({ price: lot.buyoutPrice, amount: 2, time: "2026-10-21T10:02:00Z", additional: { qlt: 4, ptn: 10 } }, 0);

test("missing or invalid attributes are unknown, explicit zero stays ordinary", () => {
  for (const additional of [undefined, {}, { qlt: null, ptn: false }, { qlt: 9, ptn: -2 }, { qlt: "", ptn: {} }]) {
    assert.deepEqual(parseAdditional({ additional }), { quality: -1, upgrade: -1 });
  }
  assert.deepEqual(parseAdditional({ additional: { qlt: 0, ptn: 0 } }), { quality: 0, upgrade: 0 });
});
test("rarity parses numeric strings, typed values and JSON additional", () => {
  for (const additional of [{ qlt: "4", ptn: "10" }, { qlt: { value: 4 }, ptn: { value: "10" } }, '{"qlt":4,"ptn":10}']) {
    assert.deepEqual(parseAdditional({ additional }), { quality: 4, upgrade: 10 });
  }
  assert.deepEqual(parseAdditional({ props: { quality: 4, upgrade: 10 } }), { quality: 4, upgrade: 10 });
});
test("history does not turn a missing exceptional rarity into ordinary", () => {
  const unknown = normalizeHistory({ price: 3_000_000_000, additional: {} }, 0);
  assert.equal(unknown.quality, -1);
  assert.equal(sale.quality, 4);
  assert.equal(unknown.price, 3_000_000_000);
});
test("normalization preserves case and valid dates; invalid dates cannot match", () => {
  assert.equal(lot.itemId, "AbC");
  const bad = normalizeLot({ price: -1, amount: 0, endTime: "not a date" }, "AbC");
  assert.equal(bad.endTime, null); assert.equal(bad.buyoutPrice, 0); assert.equal(bad.amount, 1);
});
test("legacy lot IDs are recognized without selecting a foreign lookalike", () => {
  const unknown = normalizeLot({ price: 100, startTime: lot.startTime, endTime: lot.endTime }, "AbC");
  assert.ok(unknown.legacyId);
  assert.equal(sellLotMatches(unknown, { ...sell, targetLotId: unknown.legacyId! }), true);
  assert.equal(sellLotMatches({ ...lot, id: "someone-else" }, sell), false);
});
test("rare-and-higher accepts rare, exceptional and legendary, rejects lower and unknown", () => {
  for (const quality of [-1, 0, 1, 2, 3, 4, 5]) {
    assert.equal(buyLotMatches({ ...lot, quality }, buy), quality >= 3);
  }
});
test("exact rarity remains exact; any rarity accepts missing metadata", () => {
  assert.equal(buyLotMatches(lot, { ...buy, qualityMode: "exact" }), false);
  assert.equal(buyLotMatches({ ...lot, quality: 3 }, { ...buy, qualityMode: "exact" }), true);
  assert.equal(buyLotMatches({ ...lot, quality: -1, upgrade: -1 }, { ...buy, targetQuality: -1, upgradeMode: "any" }), true);
});
test("upgrade and price bounds are independent from rarity mode", () => {
  assert.equal(buyLotMatches(lot, { ...buy, upgradeMode: "exact" }), false);
  assert.equal(buyLotMatches(lot, { ...buy, minPrice: 3_000_000_000, maxPrice: 3_000_000_000 }), true);
  assert.equal(buyLotMatches(lot, { ...buy, maxPrice: 2_999_999_999 }), false);
});
test("one missing response never completes a sale", () => {
  assert.equal(decideMissingSale({ ...sell, missCount: 1 }, [sale], true, now), null);
});
test("a sale is recognized even when the check happens after expiry", () => {
  assert.equal(decideMissingSale(sell, [sale], true, now)?.status, "sold");
});
test("different amount, rarity, upgrade and earlier sales cannot mark this lot sold", () => {
  for (const wrong of [{ ...sale, amount: 1 }, { ...sale, quality: 0 }, { ...sale, upgrade: 0 }, { ...sale, time: "2026-10-20T10:00:00Z" }]) {
    assert.notEqual(decideMissingSale(sell, [wrong], true, now)?.status, "sold");
  }
});
test("ambiguous duplicate sales do not claim a confirmed sale", () => {
  assert.notEqual(decideMissingSale(sell, [sale, { ...sale, id: "another" }], true, now)?.status, "sold");
});
test("expired vs unknown: incomplete history and missing rarity remain unconfirmed", () => {
  assert.equal(decideMissingSale(sell, [], true, now)?.status, "expired");
  assert.equal(decideMissingSale(sell, [], false, now)?.status, "removed");
  assert.equal(decideMissingSale(sell, null, false, now)?.status, "removed");
  assert.equal(decideMissingSale(sell, [{ ...sale, quality: -1 }], true, now)?.status, "removed");
});
test("removed lots without an expiry cannot hang forever; API delay has a grace period", () => {
  const missing = { ...sell, expectedEndTime: null };
  assert.equal(decideMissingSale(missing, [], true, Date.parse("2026-10-21T10:10:00Z")), null);
  assert.equal(decideMissingSale(missing, [], true, now)?.status, "removed");
});
test("search normalizes Russian names and prioritizes exact names and case-sensitive IDs", () => {
  assert.equal(normalizeSearch('  «БРАСЛЁТ»   '), "браслет");
  assert.ok(searchRank({ id: "AbC", nameRu: "Браслет" }, "браслет") < searchRank({ id: "def", nameRu: "Браслет защитный" }, "браслет"));
  assert.equal(searchRank({ id: "AbC", nameRu: "Браслет" }, "AbC"), 0);
});
test("invalid limits and tracker conditions are rejected without NaN or integer overflow", () => {
  assert.equal(boundedInt("NaN", 30, 1, 100), 30);
  assert.equal(boundedInt("-10", 30, 1, 100), 1);
  assert.equal(trackerConditionsError({ minPrice: 0, maxPrice: 3_000_000_000 }), null);
  for (const body of [{ maxPrice: -1 }, { maxPrice: Infinity }, { maxPrice: Number.MAX_SAFE_INTEGER + 1 }, { targetQuality: null }, { targetUpgrade: true }, { qualityMode: "any" }, { minPrice: 100, maxPrice: 90 }]) assert.ok(trackerConditionsError(body));
});
test("cache shares in-flight requests and does not resurrect invalidated data", async () => {
  const cache = new AsyncCache<number>(1000, 2);
  let finish!: (n: number) => void;
  let calls = 0;
  const first = cache.get("a", () => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); });
  assert.equal(first, cache.get("a", async () => 999));
  await Promise.resolve();
  cache.invalidate();
  const fresh = cache.get("a", async () => 2);
  finish(1);
  assert.equal(await first, 1); assert.equal(await fresh, 2);
  assert.equal(await cache.get("a", async () => 999), 2); assert.equal(calls, 1);
});
test("cache recovers from loader errors, expires and stays bounded", async () => {
  const cache = new AsyncCache<number>(0, 2);
  await assert.rejects(cache.get("a", async () => { throw new Error("offline"); }));
  assert.equal(await cache.get("a", async () => 1), 1);
  assert.equal(await cache.get("a", async () => 2), 2);
  await cache.get("b", async () => 3); await cache.get("c", async () => 4);
  assert.equal(cache.size, 2);
});
