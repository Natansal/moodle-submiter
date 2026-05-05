import 'dotenv/config';
import { getKeyFromEnv } from '@repo/shared-crypto';

export interface AppConfig {
  port: number;
  triggerSecret: string;
  encryptionKey: Buffer;
  mode: 'production' | 'development';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

/**
 * Validates all required environment variables and returns a strongly-typed
 * configuration object used throughout the application.
 */
export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT ?? 8080),
    triggerSecret: requireEnv('TRIGGER_SHARED_SECRET'),
    encryptionKey: getKeyFromEnv(),
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  };
}

const config = loadConfig();
export default config;
