import { sql } from "drizzle-orm";
import { db } from "@/db";

let done = false;
let running: Promise<void> | null = null;

// Создаёт таблицы, если их нет. Нужно для Render/Neon:
// после первого деплоя таблицы появятся сами, без ручного drizzle-kit push.
// Локально ничего не меняет (IF NOT EXISTS).
// ВАЖНО: по одному запросу на команду — драйвер pg не выполняет
// несколько команд через точку с запятой в одном вызове, и молча падает.
export async function ensureSchema(): Promise<void> {
  if (done) return;
  if (running) return running;
  running = (async () => {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS items (
        id text PRIMARY KEY,
        name_ru text NOT NULL,
        name_en text,
        category text NOT NULL DEFAULT 'other',
        subcategory text,
        icon_url text,
        color text,
        data_path text,
        search_text text,
        updated_at timestamp DEFAULT now()
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS trackers (
        id serial PRIMARY KEY,
        item_id text NOT NULL,
        item_name text NOT NULL,
        item_icon text,
        region text NOT NULL DEFAULT 'RU',
        upgrade_mode text NOT NULL DEFAULT 'exact',
        target_upgrade integer NOT NULL DEFAULT 0,
        target_quality integer NOT NULL DEFAULT -1,
        max_price integer NOT NULL DEFAULT 0,
        min_price integer NOT NULL DEFAULT 0,
        enabled boolean NOT NULL DEFAULT true,
        enable_sound boolean NOT NULL DEFAULT true,
        enable_browser boolean NOT NULL DEFAULT true,
        notify_chat_ids jsonb,
        match_count integer NOT NULL DEFAULT 0,
        last_checked_at timestamp,
        last_matched_at timestamp,
        last_seen_lot_ids jsonb,
        created_at timestamp DEFAULT now()
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS notifications (
        id serial PRIMARY KEY,
        tracker_id integer,
        item_id text NOT NULL,
        item_name text NOT NULL,
        item_icon text,
        region text NOT NULL DEFAULT 'RU',
        lot_id text,
        price integer NOT NULL DEFAULT 0,
        upgrade integer NOT NULL DEFAULT 0,
        quality integer NOT NULL DEFAULT 0,
        quality_name text,
        message text,
        is_read boolean NOT NULL DEFAULT false,
        target_chat_ids jsonb,
        sent_chat_ids jsonb,
        sent_at timestamp,
        attempts integer NOT NULL DEFAULT 0,
        retry_at timestamp DEFAULT now(),
        delivery_error text,
        created_at timestamp DEFAULT now()
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS telegram_chats (
        chat_id text PRIMARY KEY,
        name text,
        username text,
        is_active boolean NOT NULL DEFAULT true,
        linked_at timestamp DEFAULT now(),
        last_message_at timestamp
      );
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS app_settings (
        key text PRIMARY KEY,
        value text NOT NULL DEFAULT '',
        updated_at timestamp DEFAULT now()
      );
    `);
    // Мягкая миграция: колонка notify_chat_ids добавлена позже —
    // на старых базах её может не быть.
    await db.execute(sql`
      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS notify_chat_ids jsonb;
    `);
    await db.execute(sql`
      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS last_result_count integer NOT NULL DEFAULT 0;
    `);
    await db.execute(sql`
      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS last_api_total integer NOT NULL DEFAULT 0;
    `);
    await db.execute(sql`
      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS last_error text;
    `);
    await db.execute(sql`
      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS initial_report_sent boolean NOT NULL DEFAULT false;
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS items_search_idx ON items (search_text);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS items_category_idx ON items (category);
    `);
    await db.execute(sql`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_chat_ids jsonb;
    `);
    await db.execute(sql`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_chat_ids jsonb;
    `);
    await db.execute(sql`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_at timestamp;
    `);
    await db.execute(sql`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
    `);
    await db.execute(sql`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS retry_at timestamp DEFAULT now();
    `);
    await db.execute(sql`
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivery_error text;
    `);
    await db.execute(sql`
      UPDATE notifications
      SET sent_at = COALESCE(sent_at, created_at), sent_chat_ids = COALESCE(sent_chat_ids, '[]'::jsonb)
      WHERE target_chat_ids IS NULL AND sent_at IS NULL;
    `);
    await db.execute(sql`
      DELETE FROM notifications a USING notifications b
      WHERE a.id > b.id AND a.tracker_id = b.tracker_id AND a.lot_id = b.lot_id;
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS notifications_tracker_lot_uidx
      ON notifications (tracker_id, lot_id)
      WHERE tracker_id IS NOT NULL AND lot_id IS NOT NULL;
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at DESC);
    `);
    done = true;
  })().catch((e) => {
    running = null;
    throw e;
  });
  return running;
}
