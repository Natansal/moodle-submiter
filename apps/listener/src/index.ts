import './prefer-ipv4-dns.js';
import 'dotenv/config';
import type { Server } from 'node:http';
import { initDatabase } from '@repo/database';
import { createApp } from './app.js';
import { logListenerError } from './log-listener-error.js';
import { SessionManager } from './session-manager.js';

async function bootstrap() {
  await initDatabase();
  const sessionManager = new SessionManager();
  const app = createApp(sessionManager);
  const port = Number(process.env.PORT ?? 3001);
  const host = process.env.HOST ?? '0.0.0.0';

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, host, () => {
      console.log(`[Listener] API listening on http://${host}:${port}`);
      resolve(s);
    });
    s.on('error', reject);
  });

  void sessionManager.bootstrap().catch((error) => {
    logListenerError('[Listener] Session bootstrap failed', error);
  });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Listener] ${signal} received — shutting down...`);
    server.close(async () => {
      await sessionManager.dispose();
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  logListenerError('[Listener] Failed to bootstrap', error);
  process.exit(1);
});
