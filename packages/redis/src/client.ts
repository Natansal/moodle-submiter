import 'dotenv/config';
import { Redis } from '@upstash/redis';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[@repo/redis] Environment variable ${name} is required.`);
  }
  return value;
}

let instance: Redis | undefined;

export function getRedisClient(): Redis {
  if (!instance) {
    instance = new Redis({
      url: requireEnv('UPSTASH_REDIS_REST_URL'),
      token: requireEnv('UPSTASH_REDIS_REST_TOKEN'),
    });
  }
  return instance;
}
