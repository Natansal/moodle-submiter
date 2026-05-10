import Boom from '@hapi/boom';
import {
  BufferJSON,
  DisconnectReason,
  downloadContentFromMessage,
  fetchLatestWaWebVersion,
  initAuthCreds,
  jidNormalizedUser,
  makeWASocket,
  type WASocket,
  type WAMessage,
  type WAVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { decryptJson, encryptJson, getKeyFromEnv } from '@repo/shared-crypto';
import { getPrismaClient, usePrismaAuthState, type PrismaClient } from '@repo/database';
import { SettingsService, type PrivateMonitor, type Uptime } from '@repo/redis';
import type { EncryptedCredentials, WebhookPayload } from '@repo/shared-types';
import type { Prisma } from '@repo/database';
import {
  buildPrivateMonitors,
  collectJidAliases,
  expandedFromDbRow,
  expandedMonitoredJids,
  jidsShareIdentity,
  mergeMonitorsBySource,
  monitorsForDbRow,
  partitionMonitoredIds,
} from './private-monitor-aliases.js';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr') as typeof import('jsqr').default;

const MOODLE_HOST = 'moodle.huji.ac.il';
const MOODLE_URL_REGEX = /(https:\/\/moodle\.huji\.ac\.il[^\s]+)/i;
const GENERIC_URL_REGEX = /(https?:\/\/[^\s]+)/i;
const IMAGE_QR_MAX_BYTES = 6 * 1024 * 1024;
const IMAGE_QR_MAX_EDGE = 1600;
const IMAGE_QR_TIMEOUT_MS = 5000;
const IMAGE_QR_COOLDOWN_MS = 20_000;

type UserSettingsRow = {
  activeGroupIds: string[];
  privateMonitors: Prisma.JsonValue | null;
  encryptedCredentials: Prisma.JsonValue | null;
  uptimes: Prisma.JsonValue | null;
  active: boolean;
};

type ListenerCredentials = { email: string; password: string };

export interface SessionQrEvent {
  userId: string;
  qr: string;
}

export interface SessionReadyEvent {
  userId: string;
  connected: boolean;
}

export type ListedChat = {
  id: string;
  subject: string;
  kind: 'group' | 'private';
};

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, WASocket>();
  private readonly sessionConnected = new Map<string, boolean>();
  /** Latest QR string per user (Baileys may emit before any HTTP client is listening). */
  private readonly lastQrByUser = new Map<string, string>();
  /** Serializes createSession per user to avoid parallel duplicate sockets (e.g. React Strict Mode). */
  private readonly createSessionChain = new Map<string, Promise<void>>();
  private prismaSingleton: PrismaClient | undefined;

  private get prisma(): PrismaClient {
    if (!this.prismaSingleton) {
      this.prismaSingleton = getPrismaClient();
    }
    return this.prismaSingleton;
  }

  private readonly settingsService = new SettingsService();

  private encryptionKeySingleton: Buffer | undefined;

  private get encryptionKey(): Buffer {
    if (!this.encryptionKeySingleton) {
      this.encryptionKeySingleton = getKeyFromEnv();
    }
    return this.encryptionKeySingleton;
  }

  /** Fresh WA Web version from sw.js; cleared on 405 so the next connect re-fetches (stale build → Connection Failure 405). */
  private cachedWaWebVersion: { version: WAVersion; isLatest: boolean } | null = null;
  private waVersionFetch: Promise<WAVersion> | null = null;
  /** Per-process cache of users we've already provisioned (users + default user_settings row). */
  private readonly provisionedUsers = new Set<string>();
  private readonly provisioningInFlight = new Map<string, Promise<void>>();
  /** Basic anti-burst guard to avoid scanning too many images from same chat in a short window. */
  private readonly imageQrCooldownByChat = new Map<string, number>();

  constructor() {
    super();
  }

  /**
   * Auto-provision a `users` row + default `user_settings` row on first authenticated request.
   * Uses an in-memory cache so subsequent calls in this process are no-ops.
   */
  async ensureUserExists(userId: string, email: string | undefined): Promise<void> {
    if (this.provisionedUsers.has(userId)) return;
    const inflight = this.provisioningInFlight.get(userId);
    if (inflight) return inflight;

    const task = (async () => {
      try {
        await this.prisma.user.upsert({
          where: { id: userId },
          update: email ? { email } : {},
          create: { id: userId, email: email ?? `${userId}@unknown.local` },
        });

        await this.prisma.userSettings.upsert({
          where: { userId },
          update: {},
          create: {
            userId,
            activeGroupIds: [],
            uptimes: [],
            active: true,
          },
        });

        this.provisionedUsers.add(userId);
      } finally {
        this.provisioningInFlight.delete(userId);
      }
    })();

    this.provisioningInFlight.set(userId, task);
    return task;
  }

  async bootstrap(): Promise<void> {
    const rows = await this.prisma.userSettings.findMany({
      where: { active: true },
    });

    await Promise.all(
      rows
        .filter((r) => r.encryptedCredentials != null)
        .map((r) =>
          this.applyDbUserSettingsRowToRedis(r.userId, r).catch((error) => {
            console.error(`[SessionManager] Failed to hydrate Redis for ${r.userId}:`, error);
          }),
        ),
    );

    await Promise.all(
      rows.map(async ({ userId }) => {
        try {
          await this.createSession(userId);
        } catch (error) {
          console.error(`[SessionManager] Failed to bootstrap user ${userId}:`, error);
        }
      }),
    );
  }

  getSocket(userId: string): WASocket | undefined {
    return this.sessions.get(userId);
  }

  isSessionConnected(userId: string): boolean {
    return this.sessionConnected.get(userId) === true;
  }

  /** Last Baileys QR string for this user (for clients that connect after bootstrap). */
  getLatestQr(userId: string): string | undefined {
    return this.lastQrByUser.get(userId);
  }

  async destroySession(userId: string): Promise<void> {
    const existing = this.sessions.get(userId);
    if (existing) {
      existing.end(undefined);
      this.sessions.delete(userId);
      this.sessionConnected.set(userId, false);
    }
    this.lastQrByUser.delete(userId);
  }

  async createSession(userId: string): Promise<void> {
    const previous = this.createSessionChain.get(userId) ?? Promise.resolve();
    const next = previous
      .then(() => this.createSessionWorker(userId))
      .catch((error) => {
        console.error(`[SessionManager] createSession failed for ${userId}:`, error);
      });
    this.createSessionChain.set(userId, next);
    void next.finally(() => {
      if (this.createSessionChain.get(userId) === next) {
        this.createSessionChain.delete(userId);
      }
    });
    await next;
  }

  private async resolveWaWebVersion(): Promise<WAVersion> {
    if (this.cachedWaWebVersion) {
      return this.cachedWaWebVersion.version;
    }
    if (!this.waVersionFetch) {
      this.waVersionFetch = fetchLatestWaWebVersion({}).then((result) => {
        this.cachedWaWebVersion = {
          version: result.version,
          isLatest: result.isLatest,
        };
        return result.version;
      });
    }
    return this.waVersionFetch;
  }

  private async createSessionWorker(userId: string): Promise<void> {
    if (this.sessions.has(userId) && this.sessionConnected.get(userId)) {
      return;
    }

    if (this.sessions.has(userId)) {
      return;
    }

    const userExists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!userExists) {
      console.error(
        `[SessionManager] Skipping session bootstrap for ${userId}: user row is missing (would violate whatsapp_sessions_userId_fkey).`,
      );
      return;
    }

    const version = await this.resolveWaWebVersion();

    const { state, saveCreds } = await usePrismaAuthState(this.prisma, userId);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Chrome', 'Desktop', '127.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
      fireInitQueries: true,
      getMessage: async () => undefined,
    });

    this.sessions.set(userId, sock);
    this.sessionConnected.set(userId, false);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.lastQrByUser.set(userId, qr);
        this.emit('session:qr', { userId, qr } satisfies SessionQrEvent);
      }

      if (connection === 'close') {
        this.sessions.delete(userId);
        this.sessionConnected.set(userId, false);
        this.emit('session:ready', { userId, connected: false } satisfies SessionReadyEvent);
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (statusCode === 405) {
          this.cachedWaWebVersion = null;
          this.waVersionFetch = null;
        }
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (statusCode === DisconnectReason.loggedOut) {
          await this.resetAuthState(userId);
        }

        if (shouldReconnect || statusCode === DisconnectReason.loggedOut) {
          setTimeout(() => {
            this.createSession(userId).catch((error) => {
              console.error(`[SessionManager] Reconnect failed for ${userId}:`, error);
            });
          }, 1500);
        }
      }

      if (connection === 'open') {
        this.lastQrByUser.delete(userId);
        this.sessionConnected.set(userId, true);
        this.emit('session:ready', { userId, connected: true } satisfies SessionReadyEvent);
        void (async () => {
          try {
            await this.hydrateRedisSettingsFromDbIfStale(userId);
            await this.refreshPrivateMonitorAliases(userId);
          } catch (err) {
            console.error(
              `[SessionManager] hydrateRedisSettingsFromDbIfStale / refreshPrivateMonitorAliases failed for ${userId}:`,
              err,
            );
          }
        })();
      }

      if (connection === 'connecting') {
        this.sessionConnected.set(userId, false);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      const msg = m.messages[0];
      await this.handleIncomingMessage(userId, msg);
    });
  }

  async listChats(userId: string): Promise<ListedChat[]> {
    const sock = this.sessions.get(userId);
    if (!sock || !this.isSessionConnected(userId)) {
      return [];
    }

    try {
      const groups = await sock.groupFetchAllParticipating();
      const fromGroups: ListedChat[] = Object.values(groups).map((group) => ({
        id: group.id,
        subject: group.subject || 'Unknown Group',
        kind: 'group' as const,
      }));

      return fromGroups.sort((a, b) =>
        a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' }),
      );
    } catch (error) {
      console.error(`[SessionManager] Failed to fetch chats for ${userId}:`, error);
      return [];
    }
  }

  async saveSettings(userId: string, payload: {
    email: string;
    password?: string;
    activeGroupIds: string[];
    uptimes: Uptime[];
    active: boolean;
  }): Promise<void> {
    let passwordPlain = payload.password?.trim() ?? '';

    if (!passwordPlain) {
      const cached = await this.settingsService.getSettings(userId);
      if (cached?.encryptedCredentials) {
        const previous = decryptJson<ListenerCredentials>(
          cached.encryptedCredentials as unknown as EncryptedCredentials,
          this.encryptionKey,
        );
        passwordPlain = previous?.password ?? '';
      }
    }

    if (!passwordPlain) {
      const existingRow = await this.prisma.userSettings.findUnique({ where: { userId } });
      if (existingRow?.encryptedCredentials) {
        const previous = decryptJson<ListenerCredentials>(
          existingRow.encryptedCredentials as unknown as EncryptedCredentials,
          this.encryptionKey,
        );
        passwordPlain = previous?.password ?? '';
      }
    }

    if (!passwordPlain) {
      throw Boom.badRequest('Moodle password is required on first save');
    }

    const encryptedCredentials = encryptJson(
      { email: payload.email, password: passwordPlain },
      this.encryptionKey,
    );

    await this.prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, email: payload.email },
    });

    await this.prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonObject,
        activeGroupIds: payload.activeGroupIds,
        uptimes: payload.uptimes,
        active: payload.active,
      },
      update: {
        encryptedCredentials: encryptedCredentials as unknown as Prisma.InputJsonObject,
        activeGroupIds: payload.activeGroupIds,
        uptimes: payload.uptimes,
        active: payload.active,
      },
    });

    const sock = this.sessions.get(userId);
    const { groups, privateJids } = partitionMonitoredIds(payload.activeGroupIds);
    const privateMonitors = await buildPrivateMonitors(sock, privateJids);

    await this.writePrivateMonitorsJson(userId, privateMonitors);

    const expandedJids = expandedMonitoredJids(groups, privateMonitors);

    await this.settingsService.upsertSettings(userId, {
      encryptedCredentials,
      groupIds: expandedJids,
      activeGroupIds: payload.activeGroupIds,
      uptimes: payload.uptimes,
      on: payload.active,
      privateMonitors,
    });
    this.settingsService.clearUserCache(userId);
  }

  async getSettings(userId: string) {
    const row = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (!row) return null;

    const decrypted = row.encryptedCredentials
      ? decryptJson<ListenerCredentials>(
          row.encryptedCredentials as unknown as EncryptedCredentials,
          this.encryptionKey,
        )
      : null;

    return {
      email: decrypted?.email ?? '',
      password: decrypted?.password ?? '',
      activeGroupIds: row.activeGroupIds,
      uptimes: row.uptimes,
      active: row.active,
    };
  }

  async dispose(): Promise<void> {
    this.settingsService.dispose();
    this.sessions.clear();
    await this.prismaSingleton?.$disconnect();
  }

  private isDirectChatJid(jid: string): boolean {
    if (!jid || jid.endsWith('@g.us')) return false;
    const lower = jid.toLowerCase();
    if (lower === 'status@broadcast') return false;
    if (lower.endsWith('@broadcast')) return false;
    if (lower.endsWith('@newsletter')) return false;
    return (
      jid.endsWith('@s.whatsapp.net') ||
      jid.endsWith('@lid') ||
      jid.endsWith('@c.us') ||
      jid.endsWith('@hosted') ||
      jid.endsWith('@hosted.lid')
    );
  }

  /** Match stored PN (manual entry) when WhatsApp delivers messages with `@lid`. */
  private async isMonitoredChat(userId: string, sock: WASocket, remoteJid: string): Promise<boolean> {
    if (remoteJid.endsWith('@g.us')) {
      return this.settingsService.isUserGroup(userId, remoteJid);
    }

    const candidates = new Set<string>([remoteJid]);
    try {
      const { lidMapping } = sock.signalRepository;
      if (remoteJid.endsWith('@lid')) {
        const pn = await lidMapping.getPNForLID(remoteJid);
        if (pn) {
          const n = jidNormalizedUser(pn);
          if (n) candidates.add(n);
        }
      } else if (remoteJid.endsWith('@s.whatsapp.net')) {
        const lid = await lidMapping.getLIDForPN(remoteJid);
        if (lid) {
          const n = jidNormalizedUser(lid);
          if (n) candidates.add(n);
        }
      }
    } catch {
      // mapping not available yet
    }

    for (const jid of candidates) {
      if (await this.settingsService.isUserGroup(userId, jid)) return true;
    }

    if (await this.tryHealPrivateMonitors(userId, sock, remoteJid)) {
      for (const jid of candidates) {
        if (await this.settingsService.isUserGroup(userId, jid)) return true;
      }
    }
    return false;
  }

  private async handleIncomingMessage(userId: string, msg: WAMessage): Promise<void> {
    if (!msg.message || !msg.key.remoteJid || msg.key.fromMe) return;
    const sock = this.sessions.get(userId);
    if (!sock) return;

    const remoteJid = jidNormalizedUser(msg.key.remoteJid);
    if (!remoteJid) return;
    const isGroup = remoteJid.endsWith('@g.us');
    const isDirect = this.isDirectChatJid(remoteJid);
    if (!isGroup && !isDirect) return;

    await this.hydrateRedisSettingsFromDbIfStale(userId);
    if (!(await this.settingsService.isAutomationEnabled(userId))) return;

    const monitored = await this.isMonitoredChat(userId, sock, remoteJid);
    const isUserUp = await this.settingsService.isUserUpNow(userId);
    if (!monitored || !isUserUp) return;

    const targetUrl = await this.extractCandidateUrlFromMessage(userId, msg, remoteJid);
    if (!targetUrl) return;

    await sock.sendPresenceUpdate('composing', remoteJid);
    await this.sleep(900 + Math.floor(Math.random() * 1400));
    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate('paused', remoteJid);
    await this.sleep(500 + Math.floor(Math.random() * 900));

    await this.triggerAutomation(userId, targetUrl);
  }

  private async extractCandidateUrlFromMessage(
    userId: string,
    msg: WAMessage,
    remoteJid: string,
  ): Promise<string | null> {
    const messageText = this.extractTextMessage(msg);
    const textMatch = messageText.match(MOODLE_URL_REGEX);
    if (textMatch && this.isAllowedMoodleUrl(textMatch[0])) {
      return textMatch[0];
    }

    const imageMessage = this.extractImageMessage(msg);
    if (!imageMessage) return null;
    if (!this.canAttemptImageQr(userId, remoteJid)) return null;

    const declaredSize = this.toNumberOrNull((imageMessage as { fileLength?: unknown }).fileLength);
    if (declaredSize != null && declaredSize > IMAGE_QR_MAX_BYTES) {
      console.log(
        `[SessionManager] Skip image QR scan: file too large user=${userId} chat=${remoteJid} bytes=${declaredSize}`,
      );
      return null;
    }

    try {
      const imageBuffer = await this.downloadImageMessageBuffer(imageMessage);
      const qrText = await this.decodeQrFromImageBuffer(imageBuffer);
      if (!qrText) {
        console.log(`[SessionManager] Image QR not detected user=${userId} chat=${remoteJid}`);
        return null;
      }
      const genericMatch = qrText.match(GENERIC_URL_REGEX);
      if (!genericMatch || !this.isAllowedMoodleUrl(genericMatch[0])) {
        console.log(`[SessionManager] Image QR URL not allowed user=${userId} chat=${remoteJid}`);
        return null;
      }
      return genericMatch[0];
    } catch (error) {
      console.warn(`[SessionManager] Image QR scan failed user=${userId} chat=${remoteJid}:`, error);
      return null;
    }
  }

  private extractTextMessage(msg: WAMessage): string {
    const unwrapped = this.unwrapMessage(msg.message);
    const conversation = (unwrapped as { conversation?: unknown }).conversation;
    if (typeof conversation === 'string' && conversation) return conversation;
    const extended = (unwrapped as { extendedTextMessage?: { text?: unknown } }).extendedTextMessage;
    if (typeof extended?.text === 'string' && extended.text) return extended.text;
    return '';
  }

  private extractImageMessage(msg: WAMessage): Record<string, unknown> | null {
    const unwrapped = this.unwrapMessage(msg.message);
    const imageMessage = (unwrapped as { imageMessage?: unknown }).imageMessage;
    if (imageMessage && typeof imageMessage === 'object') {
      return imageMessage as Record<string, unknown>;
    }
    return null;
  }

  private unwrapMessage(message: WAMessage['message'] | undefined): Record<string, unknown> {
    let current = message as unknown;
    while (current && typeof current === 'object') {
      const node = current as Record<string, unknown>;
      const ephemeral = node['ephemeralMessage'];
      if (
        ephemeral &&
        typeof ephemeral === 'object' &&
        (ephemeral as { message?: unknown }).message &&
        typeof (ephemeral as { message?: unknown }).message === 'object'
      ) {
        current = (ephemeral as { message: unknown }).message;
        continue;
      }
      const viewOnceV1 = node['viewOnceMessage'];
      if (
        viewOnceV1 &&
        typeof viewOnceV1 === 'object' &&
        (viewOnceV1 as { message?: unknown }).message &&
        typeof (viewOnceV1 as { message?: unknown }).message === 'object'
      ) {
        current = (viewOnceV1 as { message: unknown }).message;
        continue;
      }
      const viewOnceV2 = node['viewOnceMessageV2'];
      if (
        viewOnceV2 &&
        typeof viewOnceV2 === 'object' &&
        (viewOnceV2 as { message?: unknown }).message &&
        typeof (viewOnceV2 as { message?: unknown }).message === 'object'
      ) {
        current = (viewOnceV2 as { message: unknown }).message;
        continue;
      }
      const viewOnceV2Ext = node['viewOnceMessageV2Extension'];
      if (
        viewOnceV2Ext &&
        typeof viewOnceV2Ext === 'object' &&
        (viewOnceV2Ext as { message?: unknown }).message &&
        typeof (viewOnceV2Ext as { message?: unknown }).message === 'object'
      ) {
        current = (viewOnceV2Ext as { message: unknown }).message;
        continue;
      }
      return node;
    }
    return {};
  }

  private canAttemptImageQr(userId: string, remoteJid: string): boolean {
    const key = `${userId}:${remoteJid}`;
    const now = Date.now();
    const nextAllowed = this.imageQrCooldownByChat.get(key) ?? 0;
    if (now < nextAllowed) return false;
    this.imageQrCooldownByChat.set(key, now + IMAGE_QR_COOLDOWN_MS);
    return true;
  }

  private async downloadImageMessageBuffer(imageMessage: Record<string, unknown>): Promise<Buffer> {
    const stream = await downloadContentFromMessage(imageMessage as never, 'image');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += piece.length;
      if (total > IMAGE_QR_MAX_BYTES) {
        throw new Error(`Image exceeds max bytes (${IMAGE_QR_MAX_BYTES})`);
      }
      chunks.push(piece);
    }
    return Buffer.concat(chunks);
  }

  private async decodeQrFromImageBuffer(imageBuffer: Buffer): Promise<string | null> {
    const decodeTask = (async () => {
      let pipeline = sharp(imageBuffer, { failOn: 'none' }).rotate();
      const metadata = await pipeline.metadata();
      const width = metadata.width ?? 0;
      const height = metadata.height ?? 0;
      if (width > IMAGE_QR_MAX_EDGE || height > IMAGE_QR_MAX_EDGE) {
        pipeline = pipeline.resize({
          width: IMAGE_QR_MAX_EDGE,
          height: IMAGE_QR_MAX_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const qr = jsQR(new Uint8ClampedArray(data), info.width, info.height);
      const value = qr?.data?.trim();
      return value ? value : null;
    })();

    const timeoutTask = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), IMAGE_QR_TIMEOUT_MS);
    });

    return Promise.race([decodeTask, timeoutTask]);
  }

  private isAllowedMoodleUrl(candidate: string): boolean {
    try {
      const url = new URL(candidate);
      return url.protocol === 'https:' && url.hostname.toLowerCase() === MOODLE_HOST;
    } catch {
      return false;
    }
  }

  private toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === 'bigint') return Number(value);
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { toString?: unknown }).toString === 'function'
    ) {
      const parsed = Number((value as { toString: () => string }).toString());
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  /** Push a DB `user_settings` row into Redis (expanded jids + monitors). Used at bootstrap and cold-cache hydrate. */
  private async applyDbUserSettingsRowToRedis(
    userId: string,
    row: {
      activeGroupIds: string[];
      privateMonitors?: Prisma.JsonValue | null;
      encryptedCredentials: Prisma.JsonValue | null;
      uptimes: Prisma.JsonValue | null;
      active: boolean;
    },
  ): Promise<void> {
    if (!row.encryptedCredentials) return;
    const rowTyped = row as UserSettingsRow;
    const dbMonitors = monitorsForDbRow(rowTyped.activeGroupIds, rowTyped.privateMonitors);
    await this.settingsService.upsertSettings(userId, {
      encryptedCredentials: row.encryptedCredentials as unknown as EncryptedCredentials,
      groupIds: expandedFromDbRow(rowTyped.activeGroupIds, rowTyped.privateMonitors),
      activeGroupIds: rowTyped.activeGroupIds,
      uptimes: (row.uptimes ?? []) as Uptime[],
      on: row.active,
      privateMonitors: dbMonitors,
    });
    this.settingsService.clearUserCache(userId);
  }

  /** Load settings from DB into Redis when the cache has no credentials (not used on automation hot path). */
  private async hydrateRedisSettingsFromDbIfStale(userId: string): Promise<void> {
    const cached = await this.settingsService.getSettings(userId);
    if (cached?.encryptedCredentials) return;
    const row = await this.prisma.userSettings.findUnique({ where: { userId } });
    if (!row?.encryptedCredentials) return;
    await this.applyDbUserSettingsRowToRedis(userId, row);
  }

  private async triggerAutomation(userId: string, targetUrl: string): Promise<void> {
    const cachedSettings = await this.settingsService.getSettings(userId);
    const encryptedCredentials = cachedSettings?.encryptedCredentials as EncryptedCredentials | undefined;
    if (!encryptedCredentials) {
      throw Boom.internal(
        'Encrypted credentials are missing from the listener Redis cache. Restart the listener or save settings so Redis can warm.',
      );
    }

    const workerUrl = process.env.WORKER_URL;
    const triggerSecret = process.env.TRIGGER_SHARED_SECRET;
    if (!workerUrl || !triggerSecret) {
      throw Boom.internal('WORKER_URL and TRIGGER_SHARED_SECRET are required');
    }

    const payload: WebhookPayload = {
      targetUrl,
      credentials: encryptedCredentials,
      userId,
      mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    };

    const endpoint = workerUrl.replace(/\/$/, '').endsWith('/trigger')
      ? workerUrl.replace(/\/$/, '')
      : `${workerUrl.replace(/\/$/, '')}/trigger`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${triggerSecret}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok && response.status !== 202) {
      throw Boom.badGateway(`Worker responded with status ${response.status}`);
    }
  }

  /** Re-resolve PN ↔ LID for manually added private chats; run on WhatsApp connect and after settings save. */
  private async refreshPrivateMonitorAliases(userId: string): Promise<void> {
    const sock = this.sessions.get(userId);
    if (!sock || !this.isSessionConnected(userId)) return;

    const cached = await this.settingsService.getSettings(userId);
    if (cached) {
      const { groups, privateJids } = partitionMonitoredIds(cached!.activeGroupIds!);
      const privateMonitors = await buildPrivateMonitors(sock, privateJids);

      await this.writePrivateMonitorsJson(userId, privateMonitors);

      const expanded = expandedMonitoredJids(groups, privateMonitors);
      await this.syncRedisMonitoredJids(
        userId,
        {
          encryptedCredentials: cached!.encryptedCredentials as unknown as Prisma.JsonValue,
          uptimes: cached!.uptimes as unknown as Prisma.JsonValue,
          active: cached!.on,
          activeGroupIds: cached!.activeGroupIds!,
        },
        expanded,
        privateMonitors,
      );
      return;
    }

    const row = (await this.prisma.userSettings.findUnique({ where: { userId } })) as UserSettingsRow | null;
    if (!row) return;

    const { groups, privateJids } = partitionMonitoredIds(row.activeGroupIds);
    const privateMonitors = await buildPrivateMonitors(sock, privateJids);

    await this.writePrivateMonitorsJson(userId, privateMonitors);

    const expanded = expandedMonitoredJids(groups, privateMonitors);
    await this.syncRedisMonitoredJids(
      userId,
      { ...row, activeGroupIds: row.activeGroupIds },
      expanded,
      privateMonitors,
    );
  }

  private async syncRedisMonitoredJids(
    userId: string,
    row: Pick<UserSettingsRow, 'encryptedCredentials' | 'uptimes' | 'active'> & { activeGroupIds: string[] },
    expandedJids: string[],
    privateMonitors: PrivateMonitor[],
  ): Promise<void> {
    let settings = await this.settingsService.getSettings(userId);

    if (!settings?.encryptedCredentials && row.encryptedCredentials) {
      await this.settingsService.upsertSettings(userId, {
        encryptedCredentials: row.encryptedCredentials as unknown as EncryptedCredentials,
        groupIds: expandedJids,
        activeGroupIds: row.activeGroupIds,
        uptimes: (row.uptimes ?? []) as Uptime[],
        on: row.active,
        privateMonitors,
      });
      return;
    }
    if (settings) {
      await this.settingsService.upsertSettings(userId, {
        ...settings,
        groupIds: expandedJids,
        privateMonitors,
        activeGroupIds: row.activeGroupIds,
      });
    }
  }

  /**
   * If WA delivered a JID we had not cached yet, merge aliases into privateMonitors + Redis (same contact as a manual row).
   */
  private async tryHealPrivateMonitors(userId: string, sock: WASocket, remoteJid: string): Promise<boolean> {
    const cached = await this.settingsService.getSettings(userId);
    let monitors: PrivateMonitor[];
    let groups: string[];

    if (cached?.privateMonitors && cached.privateMonitors.length > 0) {
      monitors = cached.privateMonitors.map((m) => ({ ...m, aliases: [...m.aliases] }));
      groups = cached.groupIds.filter((id) => id.endsWith('@g.us'));
    } else if (cached) {
      monitors = monitorsForDbRow(cached!.activeGroupIds!, cached!.privateMonitors);
      groups = partitionMonitoredIds(cached!.activeGroupIds!).groups;
    } else {
      const row = (await this.prisma.userSettings.findUnique({ where: { userId } })) as UserSettingsRow | null;
      if (!row) return false;
      monitors = monitorsForDbRow(row.activeGroupIds, row.privateMonitors);
      groups = partitionMonitoredIds(row.activeGroupIds).groups;
    }

    if (monitors.length === 0) return false;

    const updated = monitors.map((m) => ({ ...m, aliases: [...m.aliases] }));
    let changed = false;

    for (let i = 0; i < updated.length; i++) {
      const m = updated[i]!;
      if (!(await jidsShareIdentity(sock, m.source, remoteJid))) continue;

      const merged = new Set(m.aliases);
      for (const a of await collectJidAliases(sock, remoteJid)) merged.add(a);
      for (const a of await collectJidAliases(sock, m.source)) merged.add(a);
      const before = new Set(m.aliases);
      const next = [...merged];
      if (before.size !== merged.size || !next.every((a) => before.has(a))) {
        updated[i] = { ...m, aliases: next };
        changed = true;
      }
    }

    if (!changed) return false;

    const mergedMonitors = mergeMonitorsBySource(updated);
    await this.writePrivateMonitorsJson(userId, mergedMonitors);

    const expanded = expandedMonitoredJids(groups, mergedMonitors);
    const settings = await this.settingsService.getSettings(userId);
    if (settings) {
      await this.settingsService.upsertSettings(userId, {
        ...settings,
        groupIds: expanded,
        privateMonitors: mergedMonitors,
      });
      return true;
    }

    const rowFallback = (await this.prisma.userSettings.findUnique({
      where: { userId },
    })) as UserSettingsRow | null;
    if (rowFallback) {
      await this.syncRedisMonitoredJids(
        userId,
        { ...rowFallback, activeGroupIds: rowFallback.activeGroupIds },
        expanded,
        mergedMonitors,
      );
    }
    return true;
  }

  private async writePrivateMonitorsJson(userId: string, monitors: PrivateMonitor[]): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE "user_settings" SET "privateMonitors" = $1::jsonb, "updatedAt" = NOW() WHERE "userId" = $2::uuid`,
      JSON.stringify(monitors),
      userId,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async resetAuthState(userId: string): Promise<void> {
    const creds = JSON.parse(JSON.stringify(initAuthCreds(), BufferJSON.replacer));
    await this.prisma.whatsAppSession.upsert({
      where: { userId },
      create: { userId, creds, keys: {} },
      update: { creds, keys: {} },
    });
    this.lastQrByUser.delete(userId);
  }
}
