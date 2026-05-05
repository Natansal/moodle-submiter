import { createHash } from 'node:crypto';
import type { Redis } from '@upstash/redis';
import { getRedisClient } from './client.js';

const DEFAULT_LOCK_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export class LockService {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(ttlSeconds = DEFAULT_LOCK_TTL_SECONDS) {
    this.redis = getRedisClient();
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Attempts to acquire a distributed lock for a given email + URL pair.
   * Returns `true` if the lock was acquired (first time processing),
   * or `false` if the link was already processed (duplicate).
   * Keys auto-expire after the configured TTL to prevent unbounded growth.
   */
  async acquire(email: string, url: string): Promise<boolean> {
    const lockKey = this.buildKey(email, url);
    const result = await this.redis.set(lockKey, 'processed', {
      nx: true,
      ex: this.ttlSeconds,
    });
    return result === 'OK';
  }

  /**
   * Releases a previously acquired lock. Used to allow retries after failures.
   */
  async release(email: string, url: string): Promise<void> {
    const lockKey = this.buildKey(email, url);
    await this.redis.del(lockKey);
  }

  private buildKey(email: string, url: string): string {
    const hash = createHash('sha256').update(`${email}:${url}`).digest('hex');
    return `lock:${hash}`;
  }
}
