import { config as loadDotenv } from 'dotenv';
import { getKeyFromEnv } from '@repo/shared-crypto';

export interface AppConfig {
  port: number;
  triggerSecret: string;
  encryptionKey: Buffer;
  mode: 'production' | 'development';
}

/** Cloud Run sets PORT; empty string must not become listen(0). */
function parseListenPort(): number {
  const raw = getEnv('PORT');
  if (raw === undefined || raw === '') {
    return 8080;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 8080;
}

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
}

function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

/** Secret Manager values often include a trailing newline — trim before validation. */
function normalizeSecretEnv(keys: readonly string[]): void {
  for (const key of keys) {
    const v = process.env[key];
    if (typeof v === 'string') {
      process.env[key] = v.trim();
    }
  }
}

/**
 * Validates all required environment variables and returns a strongly-typed
 * configuration object used throughout the application.
 */
export function loadConfig(): AppConfig {
  if (getEnv('NODE_ENV') !== 'production') {
    loadDotenv();
  }

  normalizeSecretEnv([
    'TRIGGER_SHARED_SECRET',
    'CREDENTIALS_ENCRYPTION_KEY',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
  ]);

  return {
    port: parseListenPort(),
    triggerSecret: requireEnv('TRIGGER_SHARED_SECRET'),
    encryptionKey: getKeyFromEnv(),
    mode: getEnv('NODE_ENV') === 'production' ? 'production' : 'development',
  };
}

const config = loadConfig();
export default config;
