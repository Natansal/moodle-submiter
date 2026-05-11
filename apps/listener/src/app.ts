import express from 'express';
import cors from 'cors';
import Boom from '@hapi/boom';
import type { NextFunction, Response } from 'express';
import { authMiddleware, type AuthedRequest } from './api/auth.middleware.js';
import { boomErrorHandler } from './api/boom-error-handler.js';
import { SessionManager } from './session-manager.js';
import type { ListenerSettingsPayload } from '@repo/shared-types';
import type { Day, Uptime } from '@repo/redis';

function ensureUserMiddleware(sessionManager: SessionManager) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      if (!req.userId) throw Boom.unauthorized('Missing user id');
      await sessionManager.ensureUserExists(req.userId, req.userEmail);
      next();
    } catch (error) {
      next(Boom.isBoom(error) ? error : Boom.internal('Failed to provision user'));
    }
  };
}

const VALID_DAYS: ReadonlySet<Day> = new Set([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

function parseUptimes(input: ListenerSettingsPayload['uptimes']): Uptime[] {
  if (!Array.isArray(input)) return [];

  const out: Uptime[] = [];
  for (const item of input) {
    if (!item || typeof item.day !== 'string' || !VALID_DAYS.has(item.day as Day)) continue;
    const day = item.day as Day;
    const rawRanges = Array.isArray(item.ranges) ? item.ranges : [];
    const ranges: { start: number; end: number }[] = [];
    for (const range of rawRanges) {
      if (!range || typeof range.start !== 'number' || typeof range.end !== 'number') continue;
      const start = Math.max(0, Math.min(1440, Math.floor(range.start)));
      const end = Math.max(0, Math.min(1440, Math.floor(range.end)));
      if (start < end) ranges.push({ start, end });
    }
    out.push({ day, ranges });
  }
  return out;
}

/** Browser Origin header is scheme+host+port only — never includes /repo path (GitHub Pages). */
function normalizedWebOrigin(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return u.origin;
  } catch {
    return raw.trim();
  }
}

export function createApp(sessionManager: SessionManager): express.Express {
  const app = express();
  const clientOrigin = normalizedWebOrigin(process.env.CLIENT_ORIGIN ?? 'http://localhost:5173');

  app.use(
    cors({
      origin: clientOrigin,
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['content-type', 'authorization'],
    }),
  );
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.use('/api', authMiddleware);
  app.use('/api', ensureUserMiddleware(sessionManager));

  /**
   * QR + session state for the setup page (short polling from the client while that route is mounted).
   * TryCloudflare quick tunnels buffer GET SSE; polling avoids that (cloudflared#1449).
   */
  app.get('/api/qr/poll', async (req: AuthedRequest, res) => {
    const userId = req.userId;
    if (!userId) {
      throw Boom.unauthorized('Missing user id');
    }

    await sessionManager.createSession(userId);

    res.setHeader('cache-control', 'no-store');
    res.status(200).json({
      qr: sessionManager.getLatestQr(userId) ?? null,
      connected: sessionManager.isSessionConnected(userId),
    });
  });

  app.get('/api/chats', async (req: AuthedRequest, res) => {
    const userId = req.userId;
    if (!userId) {
      throw Boom.unauthorized('Missing user id');
    }

    const connected = sessionManager.isSessionConnected(userId);
    const chats = connected ? await sessionManager.listChats(userId) : [];
    res.status(200).json({
      chats,
      sessionActive: connected,
      message: connected
        ? undefined
        : 'No active WhatsApp session yet. Scan QR first.',
    });
  });

  app.get('/api/settings', async (req: AuthedRequest, res) => {
    const userId = req.userId;
    if (!userId) {
      throw Boom.unauthorized('Missing user id');
    }
    const settings = await sessionManager.getSettings(userId);
    res.status(200).json({ settings });
  });

  app.post('/api/settings', async (req: AuthedRequest, res) => {
    const userId = req.userId;
    if (!userId) {
      throw Boom.unauthorized('Missing user id');
    }

    const body = req.body as ListenerSettingsPayload | undefined;
    if (!body || !body.email || !Array.isArray(body.activeGroupIds)) {
      throw Boom.badRequest('Invalid settings payload');
    }

    await sessionManager.saveSettings(userId, {
      email: body.email,
      password: body.password,
      activeGroupIds: body.activeGroupIds,
      uptimes: parseUptimes(body.uptimes ?? []),
      active: body.active ?? true,
    });

    res.status(200).json({ saved: true });
  });

  app.use(boomErrorHandler);
  return app;
}
