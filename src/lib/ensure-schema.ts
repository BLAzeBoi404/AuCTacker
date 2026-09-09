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
      CREATE INDEX IF NOT EXISTS items_search_idx ON items (search_text);
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS items_category_idx ON items (category);
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
