import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  DATABASE_URL: z.string().min(20),

  EVOLUTION_BASE_URL: z.string().url(),
  EVOLUTION_GLOBAL_API_KEY: z.string().min(4),
  EVOLUTION_INBOUND_TOKEN: z.string().default(""),

  PUBLIC_BASE_URL: z.string().url(),
  ADMIN_TOKEN: z.string().min(20),
  WEBHOOK_SIGNING_SECRET: z.string().min(20),

  CORS_ORIGINS: z.string().default(""),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
};

export type Config = typeof config;