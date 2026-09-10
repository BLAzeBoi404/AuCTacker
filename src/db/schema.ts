import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

// Кэш предметов из stalzone-database (listing.json)
export const items = pgTable("items", {
  id: text("id").primaryKey(),
  nameRu: text("name_ru").notNull(),
  nameEn: text("name_en"),
  category: text("category").notNull().default("other"),
  subcategory: text("subcategory"),
  iconUrl: text("icon_url"),
  color: text("color"),
  dataPath: text("data_path"),
  searchText: text("search_text"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Трекеры слежки за лотами
export const trackers = pgTable("trackers", {
  id: serial("id").primaryKey(),
  itemId: text("item_id").notNull(),
  itemName: text("item_name").notNull(),
  itemIcon: text("item_icon"),
  region: text("region").notNull().default("RU"),
  upgradeMode: text("upgrade_mode").notNull().default("exact"), // exact | min | any
  targetUpgrade: integer("target_upgrade").notNull().default(0),
  targetQuality: integer("target_quality").notNull().default(-1), // -1 = любая
  maxPrice: integer("max_price").notNull().default(0), // 0 = любая
  minPrice: integer("min_price").notNull().default(0),
  enabled: boolean("enabled").notNull().default(true),
  enableSound: boolean("enable_sound").notNull().default(true),
  enableBrowser: boolean("enable_browser").notNull().default(true),
  // Кому слать в Telegram: пусто/null = всем привязанным чатам
  notifyChatIds: jsonb("notify_chat_ids").$type<string[]>(),
  matchCount: integer("match_count").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at"),
  lastMatchedAt: timestamp("last_matched_at"),
  lastSeenLotIds: jsonb("last_seen_lot_ids").$type<string[]>(),
  lastResultCount: integer("last_result_count").notNull().default(0),
  lastApiTotal: integer("last_api_total").notNull().default(0),
  lastError: text("last_error"),
  initialReportSent: boolean("initial_report_sent").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// Уведомления о найденных лотах
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  trackerId: integer("tracker_id"),
  itemId: text("item_id").notNull(),
  itemName: text("item_name").notNull(),
  itemIcon: text("item_icon"),
  region: text("region").notNull().default("RU"),
  lotId: text("lot_id"),
  price: integer("price").notNull().default(0),
  upgrade: integer("upgrade").notNull().default(0),
  quality: integer("quality").notNull().default(0),
  qualityName: text("quality_name"),
  message: text("message"),
  isRead: boolean("is_read").notNull().default(false),
  targetChatIds: jsonb("target_chat_ids").$type<string[]>(),
  sentChatIds: jsonb("sent_chat_ids").$type<string[]>(),
  sentAt: timestamp("sent_at"),
  attempts: integer("attempts").notNull().default(0),
  retryAt: timestamp("retry_at").defaultNow(),
  deliveryError: text("delivery_error"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Привязанные Telegram-чаты для уведомлений
export const telegramChats = pgTable("telegram_chats", {
  chatId: text("chat_id").primaryKey(),
  name: text("name"),
  username: text("username"),
  isActive: boolean("is_active").notNull().default(true),
  linkedAt: timestamp("linked_at").defaultNow(),
  lastMessageAt: timestamp("last_message_at"),
});

// Настройки приложения (ключ-значение)
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Item = typeof items.$inferSelect;
export type Tracker = typeof trackers.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type TelegramChat = typeof telegramChats.$inferSelect;
