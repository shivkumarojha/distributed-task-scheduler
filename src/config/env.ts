import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Environment configuration, validated once at process start.
 *
 * The rule of thumb: read `process.env` in exactly ONE place (here) and let the
 * rest of the app import the typed, frozen `config` object. That way a typo or
 * a missing variable fails loudly at boot instead of silently at 3am.
 */

// Load `.env` into process.env (no-op if the file is absent).
loadDotenv();

/**
 * Turn an empty string into `undefined`.
 *
 * Why: `dotenv` gives us `REDIS_PASSWORD=` as `""`. Passed through, ioredis
 * would try to AUTH with an empty password and fail. Treat blank as "absent".
 */
const emptyStringToUndefined = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

/** Numbers arrive from the environment as strings, so coerce them. */
const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ---- Redis connection ----------------------------------------------------
  REDIS_HOST: z.string().min(1).default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().int().positive().max(65535).default(6379),
  REDIS_PASSWORD: emptyStringToUndefined,
  REDIS_USERNAME: emptyStringToUndefined,
  REDIS_DB: z.coerce.number().int().min(0).default(0),
  REDIS_KEY_PREFIX: z.string().min(1).default('dts'),

  // ---- Redis timeouts / retry ---------------------------------------------
  REDIS_CONNECT_TIMEOUT_MS: positiveInt(5000),
  REDIS_COMMAND_TIMEOUT_MS: positiveInt(5000),
  REDIS_MAX_RETRY_DELAY_MS: positiveInt(2000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Deliberately uses console (not the logger) — the logger itself depends on
  // valid config, so it may not be usable yet.
  console.error('❌ Invalid environment configuration:\n');
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.') || '(root)';
    console.error(`   • ${path}: ${issue.message}`);
  }
  console.error('\nHint: copy .env.example to .env and fill in the missing values.');
  process.exit(1);
}

/** Validated, immutable configuration. */
export const config = Object.freeze(parsed.data);

export type AppConfig = typeof config;
export type Env = AppConfig;
