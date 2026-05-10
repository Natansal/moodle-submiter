import express from 'express';
import type { AppConfig } from './config.js';
import { LockService } from '@repo/redis';
import { createTriggerRouter } from './routes/trigger.route.js';
import { boomErrorHandler } from './middleware/boom-error-handler.js';

/**
 * Creates a fully configured Express application with all middleware
 * and routes mounted. Does not start listening — the caller is responsible
 * for binding to a port.
 */
export function createApp(config: AppConfig): express.Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '16kb' }));

  app.get('/ping', (_req, res) => {
    res.status(200).send('ok');
  });

  const lockService = new LockService();

  app.use(createTriggerRouter(config, lockService));

  app.use(boomErrorHandler);

  return app;
}
