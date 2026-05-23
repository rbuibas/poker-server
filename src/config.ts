import { z } from 'zod';

/**
 * A fixed JWT secret used ONLY in DEV_NO_DB mode when the user hasn't
 * provided their own. Not valid for production. Long enough to satisfy
 * the zod 20-char floor.
 */
export const DEV_JWT_SECRET = 'dev-only-secret-32-characters-minimum!';

const Bool = z
  .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false'), z.undefined()])
  .transform((v) => v === '1' || v === 'true');

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3001),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
    SUPABASE_JWT_SECRET: z.string().min(20).optional(),
    ALLOWED_ORIGINS: z.string().default('http://localhost:5173'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    /**
     * Local-play mode: skip Supabase entirely. Server uses in-memory stores
     * and pre-creates a single lounge that every authenticated user is
     * auto-added to. Never enable in production.
     */
    DEV_NO_DB: Bool.default('0'),
  })
  .refine(
    (c) =>
      c.DEV_NO_DB ||
      (c.SUPABASE_URL && c.SUPABASE_SERVICE_ROLE_KEY && c.SUPABASE_JWT_SECRET),
    {
      message:
        'SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_JWT_SECRET are required unless DEV_NO_DB=1',
    },
  );

export type Config = {
  PORT: number;
  NODE_ENV: 'development' | 'test' | 'production';
  SUPABASE_URL: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY: string | undefined;
  SUPABASE_JWT_SECRET: string;
  ALLOWED_ORIGINS: string;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  DEV_NO_DB: boolean;
  allowedOriginList: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  return {
    PORT: parsed.PORT,
    NODE_ENV: parsed.NODE_ENV,
    SUPABASE_URL: parsed.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: parsed.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: parsed.SUPABASE_JWT_SECRET ?? (parsed.DEV_NO_DB ? DEV_JWT_SECRET : ''),
    ALLOWED_ORIGINS: parsed.ALLOWED_ORIGINS,
    LOG_LEVEL: parsed.LOG_LEVEL,
    DEV_NO_DB: parsed.DEV_NO_DB,
    allowedOriginList: parsed.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  };
}
