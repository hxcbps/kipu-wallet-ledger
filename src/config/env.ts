import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  KIPU_CURRENCY: z.literal('USD').default('USD'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type AppConfig = {
  databaseUrl: string;
  dbPoolMax: number;
  currency: 'USD';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
};

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cachedConfig !== undefined) {
    return cachedConfig;
  }

  const parsed = envSchema.parse(process.env);
  cachedConfig = {
    databaseUrl: parsed.DATABASE_URL,
    dbPoolMax: parsed.DB_POOL_MAX,
    currency: parsed.KIPU_CURRENCY,
    logLevel: parsed.LOG_LEVEL,
  };
  return cachedConfig;
}

export function resetConfigForTests(): void {
  cachedConfig = undefined;
}
