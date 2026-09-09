import { defineConfig } from "drizzle-kit";

// Читает DATABASE_URL из окружения — работает и локально, и с Neon.
// Локально: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
// Neon: вставь pooled строку из Connect (с ?sslmode=require в конце).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@127.0.0.1:5432/app_db",
  },
});
