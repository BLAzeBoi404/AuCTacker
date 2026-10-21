import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("legacy PostgreSQL migration and real tracker engine with isolated API fixtures", async (t) => {
  // Внешние БД, EXBO и Telegram не используются. Выполняются настоящие SQL и код проверки.
  process.env.EXBO_CLIENT_ID = "test";
  process.env.EXBO_CLIENT_SECRET = "test";
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1/test";
  const pg = new PGlite();
  await pg.exec(await readFile("tests/fixtures/legacy-schema.sql", "utf8"));
  await pg.query("INSERT INTO trackers (item_id,item_name,owner_key,max_price) VALUES ('AbC','Старый трекер','owner',2000000000)");
  const { db, pool } = await import("../src/db/index");
  const query = async (config: string | { text: string; rowMode?: "array" | "object" }, values?: unknown[]) => {
    const text = typeof config === "string" ? config : config.text;
    return pg.query(text, values ?? [], { rowMode: typeof config === "string" ? "object" : config.rowMode,
      parsers: { 1114: (value) => value, 1184: (value) => value, 1082: (value) => value } });
  };
  pool.query = query as typeof pool.query;
  pool.connect = (async () => ({ query, release() {} })) as unknown as typeof pool.connect;
  const { ensureSchema } = await import("../src/lib/ensure-schema");
  const { runTrackerCheck, invalidateTrackerCache } = await import("../src/lib/tracker-check");
  const { setSetting } = await import("../src/lib/settings");
  const { trackers, sellTrackers, notifications } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");

  const originalFetch = globalThis.fetch;
  let rawLots: Record<string, unknown>[] = [];
  let rawHistory: Record<string, unknown>[] = [];
  let total = 0;
  let failLots = false;
  let failTelegram = false;
  let telegramSends = 0;
  let lotCalls = 0;
  let tokenCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/oauth/token") { tokenCalls++; return json({ access_token: "fixture-token", expires_in: 3600 }); }
    if (url.hostname === "api.telegram.org") {
      assert.ok(url.pathname.endsWith("/sendMessage"), `Unexpected Telegram operation: ${url.pathname}`);
      telegramSends++;
      return json(failTelegram ? { ok: false, description: "fixture retry" } : { ok: true, result: { message_id: 1 } });
    }
    assert.match(url.pathname, /^\/EU\/auction\/AbC\/(lots|history)$/);
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    if (url.pathname.endsWith("/lots")) {
      lotCalls++;
      if (failLots) return json({}, 503);
      return json({ lots: rawLots.slice(offset, offset + limit), total });
    }
    return json({ prices: rawHistory.slice(offset, offset + limit), total: rawHistory.length });
  };
  const baseLot = (id: string, quality: number) => ({ id, price: 3_000_000_000, amount: 2,
    startTime: new Date(Date.now() - 3600_000).toISOString(), endTime: new Date(Date.now() + 3600_000).toISOString(),
    additional: { qlt: quality, ptn: 10 } });
  try {
    await t.test("migration preserves old records and adds bigint / rarity / lifecycle columns", async () => {
      await ensureSchema();
      const [old] = await db.select().from(trackers);
      assert.equal(old.itemName, "Старый трекер"); assert.equal(old.maxPrice, 2_000_000_000); assert.equal(old.qualityMode, "exact");
      await db.update(trackers).set({ maxPrice: 9_000_000_000 }).where(eq(trackers.id, old.id));
      assert.equal((await db.select().from(trackers))[0].maxPrice, 9_000_000_000);
      await ensureSchema(); // repeated calls are safe
    });
    await db.delete(trackers);
    await setSetting("telegram_enabled", "0");
    await t.test("first snapshot is silent; only new rare-or-higher lots notify, once", async () => {
      rawLots = [baseLot("existing", 4)]; total = rawLots.length;
      const [buy] = await db.insert(trackers).values({ ownerKey: "owner", itemId: "AbC", itemName: "Браслет", region: "EU",
        qualityMode: "min", targetQuality: 3, upgradeMode: "min", targetUpgrade: 5 }).returning();
      invalidateTrackerCache();
      const initial = await runTrackerCheck("manual");
      assert.equal(initial.initialized, 1); assert.equal(initial.matches.length, 0);
      assert.ok((await db.select().from(trackers).where(eq(trackers.id, buy.id)))[0].lastCheckedAt);
      rawLots.push(baseLot("rare", 3), baseLot("exceptional", 4), baseLot("low", 1)); total = rawLots.length;
      const next = await runTrackerCheck("manual");
      assert.deepEqual(next.matches.map((m) => m.lotId).sort(), ["exceptional", "rare"]);
      assert.equal((await runTrackerCheck("manual")).matches.length, 0);
      invalidateTrackerCache();
      assert.equal((await runTrackerCheck("manual")).matches.length, 0);
      const rows = await db.select().from(notifications).where(eq(notifications.trackerId, buy.id));
      assert.equal(rows.length, 2); assert.equal(rows[0].price, 3_000_000_000);
      assert.equal(tokenCalls, 1); assert.equal(lotCalls, 4); // no speculative empty-page requests
      await db.delete(trackers);
    });
    await t.test("late sale recognition persists status and notification atomically", async () => {
      rawLots = []; total = 0;
      rawHistory = [{ price: 3_000_000_000, amount: 2, time: new Date(Date.now() - 7200_000).toISOString(), additional: { qlt: 4, ptn: 10 } }];
      const [sell] = await db.insert(sellTrackers).values({ ownerKey: "owner", itemId: "AbC", itemName: "Браслет", region: "EU",
        price: 3_000_000_000, amount: 2, quality: 4, upgrade: 10, targetLotId: "mine",
        createdAt: new Date(Date.now() - 86400_000), lastSeenAt: new Date(Date.now() - 10800_000), expectedEndTime: new Date(Date.now() - 3600_000) }).returning();
      invalidateTrackerCache();
      assert.equal((await runTrackerCheck("manual")).sellSold, 0);
      const [missing] = await db.select().from(sellTrackers).where(eq(sellTrackers.id, sell.id));
      assert.equal(missing.missCount, 1); assert.ok(missing.firstMissingAt);
      assert.equal((await runTrackerCheck("manual")).sellSold, 1);
      assert.equal((await runTrackerCheck("manual")).sellSold, 0);
      const [saved] = await db.select().from(sellTrackers).where(eq(sellTrackers.id, sell.id));
      assert.equal(saved.status, "sold"); assert.equal(saved.finishPrice, 3_000_000_000);
      const notes = await db.select().from(notifications).where(eq(notifications.kind, "sell_sold"));
      assert.equal(notes.length, 1);
    });
    await t.test("partial snapshots and EXBO errors do not count as a disappearance", async () => {
      rawHistory = [];
      const [sell] = await db.insert(sellTrackers).values({ ownerKey: "owner", itemId: "AbC", itemName: "Браслет", region: "EU",
        price: 100, quality: 3, upgrade: 0, targetLotId: "not-in-page" }).returning();
      total = 2500; invalidateTrackerCache();
      await runTrackerCheck("manual");
      failLots = true;
      assert.equal((await runTrackerCheck("manual")).failed, 1);
      failLots = false; invalidateTrackerCache();
      await runTrackerCheck("manual");
      const [saved] = await db.select().from(sellTrackers).where(eq(sellTrackers.id, sell.id));
      assert.equal(saved.status, "active"); assert.equal(saved.missCount, 0);
      await db.delete(sellTrackers).where(eq(sellTrackers.id, sell.id)); total = 0;
    });
    await t.test("an old missing lot without a known expiry is removed automatically", async () => {
      const [sell] = await db.insert(sellTrackers).values({ ownerKey: "owner", itemId: "AbC", itemName: "Браслет", region: "EU",
        price: 100, quality: -1, upgrade: -1, targetLotId: "old", missCount: 1,
        firstMissingAt: new Date(Date.now() - 3600_000) }).returning();
      invalidateTrackerCache(); await runTrackerCheck("manual");
      const [saved] = await db.select().from(sellTrackers).where(eq(sellTrackers.id, sell.id));
      assert.equal(saved.status, "removed");
    });
    await t.test("known expired lots cannot hang forever behind the API page limit", async () => {
      total = 2500;
      const [sell] = await db.insert(sellTrackers).values({ ownerKey: "owner", itemId: "AbC", itemName: "Браслет", region: "EU",
        price: 100, quality: 3, upgrade: 0, targetLotId: "expired-outside-page", expectedEndTime: new Date(Date.now() - 3600_000) }).returning();
      invalidateTrackerCache(); await runTrackerCheck("manual"); await runTrackerCheck("manual");
      const [saved] = await db.select().from(sellTrackers).where(eq(sellTrackers.id, sell.id));
      assert.equal(saved.status, "expired"); total = 0;
    });
    await t.test("pending delivery is retried even with no active trackers; future retries stay queued", async () => {
      await db.delete(notifications);
      await setSetting("telegram_enabled", "1"); await setSetting("telegram_bot_token", "fixture:token");
      await pg.query("INSERT INTO telegram_chats (chat_id,owner_key,is_active) VALUES ('42','owner',true)");
      await db.insert(notifications).values({ ownerKey: "owner", itemId: "AbC", itemName: "Браслет", targetChatIds: ["42"], retryAt: new Date(0) });
      failTelegram = true; invalidateTrackerCache(); await runTrackerCheck("manual");
      assert.equal(telegramSends, 1);
      const [pending] = await db.select().from(notifications);
      assert.equal(pending.sentAt, null); assert.equal(pending.attempts, 1); assert.ok(pending.retryAt!.getTime() > Date.now());
      await runTrackerCheck("manual"); // nothing due now must not disable delivery permanently
      const realNow = Date.now;
      Date.now = () => realNow() + 120_000;
      failTelegram = false;
      // retry_at is moved into the past because the SQL driver uses new Date(), not Date.now().
      await db.update(notifications).set({ retryAt: new Date(0) });
      try { await runTrackerCheck("manual"); } finally { Date.now = realNow; }
      assert.equal(telegramSends, 2);
      assert.ok((await db.select().from(notifications))[0].sentAt);
    });
    await t.test("a chat relinked to a different owner cannot receive old queued messages", async () => {
      await db.insert(notifications).values({ ownerKey: "old-owner", itemId: "AbC", itemName: "Чужое", targetChatIds: ["42"], retryAt: new Date(0) });
      invalidateTrackerCache(); await runTrackerCheck("manual");
      assert.equal(telegramSends, 2);
    });
  } finally {
    globalThis.fetch = originalFetch;
    await pg.close(); await pool.end();
  }
});
