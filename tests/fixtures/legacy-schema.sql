-- Схема из исходного архива до исправлений. Проверяет сохранение старых данных.

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
    

      CREATE TABLE IF NOT EXISTS telegram_chats (
        chat_id text PRIMARY KEY,
        name text,
        username text,
        is_active boolean NOT NULL DEFAULT true,
        linked_at timestamp DEFAULT now(),
        last_message_at timestamp
      );
    

      CREATE TABLE IF NOT EXISTS app_settings (
        key text PRIMARY KEY,
        value text NOT NULL DEFAULT '',
        updated_at timestamp DEFAULT now()
      );
    

      CREATE TABLE IF NOT EXISTS telegram_codes (
        code text PRIMARY KEY,
        owner_key text NOT NULL,
        created_at timestamp DEFAULT now()
      );
    

      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS owner_key text;
    

      ALTER TABLE telegram_chats ADD COLUMN IF NOT EXISTS owner_key text;
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS owner_key text;
    

      CREATE INDEX IF NOT EXISTS trackers_owner_idx ON trackers (owner_key);
    

      CREATE INDEX IF NOT EXISTS telegram_chats_owner_idx ON telegram_chats (owner_key);
    

      CREATE INDEX IF NOT EXISTS notifications_owner_idx ON notifications (owner_key);
    

      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS notify_chat_ids jsonb;
    

      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS last_result_count integer NOT NULL DEFAULT 0;
    

      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS last_api_total integer NOT NULL DEFAULT 0;
    

      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS last_error text;
    

      ALTER TABLE trackers ADD COLUMN IF NOT EXISTS initial_report_sent boolean NOT NULL DEFAULT false;
    

      CREATE INDEX IF NOT EXISTS items_search_idx ON items (search_text);
    

      CREATE INDEX IF NOT EXISTS items_category_idx ON items (category);
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_chat_ids jsonb;
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_chat_ids jsonb;
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS sent_at timestamp;
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS retry_at timestamp DEFAULT now();
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS delivery_error text;
    

      UPDATE notifications
      SET sent_at = COALESCE(sent_at, created_at), sent_chat_ids = COALESCE(sent_chat_ids, '[]'::jsonb)
      WHERE target_chat_ids IS NULL AND sent_at IS NULL;
    

      DELETE FROM notifications a USING notifications b
      WHERE a.id > b.id AND a.tracker_id = b.tracker_id AND a.lot_id = b.lot_id;
    

      CREATE UNIQUE INDEX IF NOT EXISTS notifications_tracker_lot_uidx
      ON notifications (tracker_id, lot_id)
      WHERE tracker_id IS NOT NULL AND lot_id IS NOT NULL;
    

      CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at DESC);
    

      CREATE TABLE IF NOT EXISTS sell_trackers (
        id serial PRIMARY KEY,
        owner_key text,
        item_id text NOT NULL,
        item_name text NOT NULL,
        item_icon text,
        region text NOT NULL DEFAULT 'EU',
        price integer NOT NULL DEFAULT 0,
        amount integer NOT NULL DEFAULT 1,
        upgrade integer NOT NULL DEFAULT 0,
        quality integer NOT NULL DEFAULT 0,
        quality_name text,
        target_lot_id text,
        start_time timestamp,
        expected_end_time timestamp,
        listed_duration_h integer,
        status text NOT NULL DEFAULT 'active',
        last_seen_at timestamp,
        finished_at timestamp,
        finish_price integer,
        miss_count integer NOT NULL DEFAULT 0,
        created_at timestamp DEFAULT now()
      );
    

      CREATE INDEX IF NOT EXISTS sell_trackers_owner_idx ON sell_trackers (owner_key);
    

      CREATE INDEX IF NOT EXISTS sell_trackers_status_idx ON sell_trackers (status);
    

      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'buy';
    

      ALTER TABLE sell_trackers ADD COLUMN IF NOT EXISTS quality_mode text NOT NULL DEFAULT 'exact';
    