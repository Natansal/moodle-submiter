import express from 'express';
import cors from 'cors';
import Boom from '@hapi/boom';
import type { NextFunction, Response } from 'express';
import { authMiddleware, type AuthedRequest } from './api/auth.middleware.js';
import { boomErrorHandler } from './api/boom-error-handler.js';
import { SessionManager, type SessionReadyEvent } from './session-manager.js';
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

export function createApp(sessionManager: SessionManager): express.Express {
  const app = express();
  const clientOrigin = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

  app.use(
    cors({
      origin: clientOrigin,
      credentials: true,
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

  app.get('/api/qr', async (req: AuthedRequest, res) => {
    const userId = req.userId;
    if (!userId) {
      throw Boom.unauthorized('Missing user id');
    }

    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders?.();

    const onQr = (event: { userId: string; qr: string }) => {
      if (event.userId !== userId) return;
      res.write(`event: qr\n`);
      res.write(`data: ${JSON.stringify({ qr: event.qr })}\n\n`);
    };

    const onReady = (event: SessionReadyEvent) => {
      if (event.userId !== userId) return;
      res.write(`event: ready\n`);
      res.write(`data: ${JSON.stringify({ connected: event.connected })}\n\n`);
    };

    sessionManager.on('session:qr', onQr);
    sessionManager.on('session:ready', onReady);

    await sessionManager.createSession(userId);

    const replayQr = sessionManager.getLatestQr(userId);
    if (replayQr) {
      res.write(`event: qr\n`);
      res.write(`data: ${JSON.stringify({ qr: replayQr })}\n\n`);
    }

    res.write(`event: ready\n`);
    res.write(`data: ${JSON.stringify({ connected: sessionManager.isSessionConnected(userId) })}\n\n`);

    req.on('close', () => {
      sessionManager.off('session:qr', onQr);
      sessionManager.off('session:ready', onReady);
      res.end();
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
