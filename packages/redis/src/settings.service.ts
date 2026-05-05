import type { Redis } from '@upstash/redis';
import { getRedisClient } from './client.js';

const KEY_PREFIX = 'settings:';

export type Day = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
export type Uptime = {
  day: Day;
  hours: {
    start: number;
    end: number;
  }
};

export interface UserSettings {
  email: string;
  password: string;
  groupIds: string[];
  uptimes: Uptime[];
}

export class SettingsService {
  private readonly redis: Redis;

  constructor() {
    this.redis = getRedisClient();
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.redis.get<T>(this.prefixed(key));
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.redis.set(this.prefixed(key), JSON.stringify(value));
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefixed(key));
  }

  async getAll(): Promise<Record<string, unknown>> {
    const keys = await this.redis.keys(`${KEY_PREFIX}*`);
    if (keys.length === 0) return {};

    const values = await this.redis.mget<unknown[]>(...keys);
    const result: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      result[keys[i]!.slice(KEY_PREFIX.length)] = values[i];
    }
    return result;
  }

  private prefixed(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }
}
