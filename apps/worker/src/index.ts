import type { Server } from 'node:http';
import config from './config.js';
import { createApp } from './app.js';

process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Worker] Uncaught exception — shutting down:', error);
  process.exit(1);
});

let server: Server | undefined;

async function main() {
  try {
    const app = createApp(config);

    const listenHost = process.env.HOST ?? '0.0.0.0';

    server = app.listen(config.port, listenHost, () => {
      console.log(`[Worker] listening on http://${listenHost}:${config.port}`);
    });
  } catch (err) {
    console.error('[Worker] Fatal startup:', err);
    process.exit(1);
  }
}

function shutdown(signal: string) {
  if (!server) {
    process.exit(0);
    return;
  }
  console.log(`[Worker] ${signal} received — draining connections...`);
  server.close(() => {
    console.log('[Worker] HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[Worker] Forceful shutdown after 10s timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
