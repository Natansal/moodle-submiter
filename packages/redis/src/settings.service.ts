import type { Redis } from '@upstash/redis';
import { getRedisClient } from './client.js';

export type Day =
  | 'sunday'
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday';

export type Range = {
  start: number;
  end: number;
};

export type Uptime = {
  day: Day;
  ranges: Range[];
};

/** PN↔LID alias sets for manually tracked private chats (mirrors DB / expand jids in `groupIds`). */
export type PrivateMonitor = { source: string; aliases: string[] };

export interface UserSettings {
  encryptedCredentials: {
    iv: string;
    ciphertext: string;
    tag: string;
  };
  /** Expanded monitored JIDs (groups + all private aliases) for fast `groupIds.includes`. */
  groupIds: string[];
  /** User dashboard selection (group + private JIDs as stored in DB). */
  activeGroupIds: string[];
  uptimes: Uptime[];
  on: boolean;
  privateMonitors: PrivateMonitor[];
}

function isDay(value: unknown): value is Day {
  return typeof value === 'string' && DAYS.includes(value as Day);
}

function isRange(value: unknown): value is Range {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Range).start === 'number' &&
    typeof (value as Range).end === 'number'
  );
}

function isUptime(value: unknown): value is Uptime {
  return (
    !!value &&
    typeof value === 'object' &&
    isDay((value as Uptime).day) &&
    Array.isArray((value as Uptime).ranges) &&
    (value as Uptime).ranges.every(isRange)
  );
}

function isPrivateMonitor(value: unknown): value is PrivateMonitor {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as PrivateMonitor).source === 'string' &&
    Array.isArray((value as PrivateMonitor).aliases) &&
    (value as PrivateMonitor).aliases.every((a) => typeof a === 'string')
  );
}

function parseStrictUserSettings(value: unknown): UserSettings | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as UserSettings;
  const creds = s.encryptedCredentials as UserSettings['encryptedCredentials'];

  if (
    !creds ||
    typeof creds.iv !== 'string' ||
    typeof creds.ciphertext !== 'string' ||
    typeof creds.tag !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(s.groupIds) || !s.groupIds.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(s.activeGroupIds) || !s.activeGroupIds.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(s.uptimes) || !s.uptimes.every(isUptime)) return null;
  if (typeof s.on !== 'boolean') return null;
  if (!Array.isArray(s.privateMonitors) || !s.privateMonitors.every(isPrivateMonitor)) return null;

  return {
    encryptedCredentials: creds,
    groupIds: s.groupIds,
    activeGroupIds: s.activeGroupIds,
    uptimes: s.uptimes,
    on: s.on,
    privateMonitors: s.privateMonitors,
  };
}

const KEY_PREFIX = 'settings:';
const CACHE_TTL_MS = 60 * 60 * 1000 * 24; // 24 hours
const CACHE_MAX_SIZE = 100;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const ISRAEL_TZ = 'Asia/Jerusalem';

const ISRAEL_TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: ISRAEL_TZ,
  weekday: 'long',
  hour: 'numeric',
  minute: 'numeric',
  hour12: false,
});

const DAYS: readonly Day[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

interface CacheEntry {
  value: UserSettings;
  expiresAt: number;
}

export class SettingsService {
  private redisSingleton: Redis | undefined;

  private get redis(): Redis {
    if (!this.redisSingleton) {
      this.redisSingleton = getRedisClient();
    }
    return this.redisSingleton;
  }

  private readonly cache = new Map<string, CacheEntry>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.evict(), CACHE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
  }

  // ── Public API ──────────────────────────────────────────────

  async updateSettings(id: string, settings: Partial<UserSettings>): Promise<boolean> {
    const current = await this.get(id);
    if (!current) return false;
    return this.set(id, { ...current, ...settings });
  }

  async upsertSettings(id: string, settings: UserSettings): Promise<boolean> {
    return this.set(id, settings);
  }

  async updateUptime(id: string, uptimes: Uptime[]): Promise<boolean> {
    return this.updateSettings(id, { uptimes });
  }

  async updateGroupIds(id: string, groupIds: UserSettings['groupIds']): Promise<boolean> {
    return this.updateSettings(id, { groupIds });
  }

  async updatePrivateMonitors(id: string, privateMonitors: PrivateMonitor[]): Promise<boolean> {
    return this.updateSettings(id, { privateMonitors });
  }

  async updateCredentials(
    id: string,
    credentials: Pick<UserSettings, 'encryptedCredentials'>,
  ): Promise<boolean> {
    return this.updateSettings(id, credentials);
  }

  async getSettings(id: string): Promise<UserSettings | null> {
    return this.get(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    return this.delete(id);
  }

  async isUserUp(id: string, date: Date): Promise<boolean> {
    const settings = await this.get(id);
    if (!settings?.on) return false;

    const day = DAYS[date.getDay()]!;
    const minuteOfDay = date.getHours() * 60 + date.getMinutes();

    const uptime = settings.uptimes.find((u) => u.day === day);
    if (!uptime) return false;

    return uptime.ranges.some((r) => minuteOfDay >= r.start && minuteOfDay < r.end);
  }

  /** When false, incoming messages must not trigger the worker (automation master switch). */
  async isAutomationEnabled(id: string): Promise<boolean> {
    const settings = await this.get(id);
    return settings?.on === true;
  }

  async isUserUpNow(id: string): Promise<boolean> {
    const parts = Object.fromEntries(
      ISRAEL_TIME_FORMAT.formatToParts(new Date()).map((p) => [p.type, p.value]),
    );

    const day = parts['weekday']!.toLowerCase() as Day;
    const minuteOfDay = Number(parts['hour']) * 60 + Number(parts['minute']);

    const settings = await this.get(id);
    if (!settings?.on) return false;

    const uptime = settings.uptimes.find((u) => u.day === day);
    if (!uptime) return false;

    return uptime.ranges.some((r) => minuteOfDay >= r.start && minuteOfDay < r.end);
  }

  async isUserGroup(id: string, groupId: string): Promise<boolean> {
    const settings = await this.get(id);
    if (!settings) return false;
    return settings.groupIds.includes(groupId);
  }

  clearUserCache(id: string): void {
    this.cache.delete(id);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async getAll(): Promise<Record<string, UserSettings>> {
    const keys = await this.redis.keys(`${KEY_PREFIX}*`);
    if (keys.length === 0) return {};

    const values = await this.redis.mget<(UserSettings | null)[]>(...keys);
    const result: Record<string, UserSettings> = {};

    for (let i = 0; i < keys.length; i++) {
      const id = keys[i]!.slice(KEY_PREFIX.length);
      const value = values[i];
      if (!value) continue;

      const parsed = parseStrictUserSettings(value);
      if (!parsed) continue;
      result[id] = parsed;
      this.cacheSet(id, parsed);
    }

    return result;
  }

  // ── Redis Accessors ─────────────────────────────────────────

  private async get(id: string): Promise<UserSettings | null> {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    this.cache.delete(id);
    const value = await this.redis.get<unknown>(this.prefixed(id));
    if (!value) return null;
    const parsed = parseStrictUserSettings(value);
    if (!parsed) {
      this.cache.delete(id);
      return null;
    }
    this.cacheSet(id, parsed);
    return parsed;
  }

  private async set(id: string, settings: UserSettings): Promise<boolean> {
    const parsed = parseStrictUserSettings(settings);
    if (!parsed) return false;
    const result = await this.redis.set(this.prefixed(id), parsed);
    if (result === 'OK') this.cacheSet(id, parsed);
    return result === 'OK';
  }

  private async delete(id: string): Promise<boolean> {
    this.cache.delete(id);
    const result = await this.redis.del(this.prefixed(id));
    return result > 0;
  }

  // ── Cache Internals ─────────────────────────────────────────

  private cacheSet(id: string, value: UserSettings): void {
    if (this.cache.size >= CACHE_MAX_SIZE) this.evict();
    this.cache.set(id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
    if (this.cache.size >= CACHE_MAX_SIZE) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
  }

  private prefixed(key: string): string {
    return `${KEY_PREFIX}${key}`;
  }
}
