import config from './config.js';
import { createApp } from './app.js';

process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Worker] Uncaught exception — shutting down:', error);
  process.exit(1);
});

const app = createApp(config);

const server = app.listen(config.port, () => {
  console.log(`[Worker] listening on :${config.port}`);
});

function shutdown(signal: string) {
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
