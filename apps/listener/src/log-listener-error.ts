import { inspect } from 'node:util';

/**
 * PM2 / journald often show `cause: [Object]` — print nested pg & Prisma fields explicitly.
 */
export function logListenerError(prefix: string, error: unknown): void {
  console.error(prefix, error);
  if (!(error instanceof Error)) return;

  if (error.message) {
    console.error(`${prefix} message:`, error.message);
  }

  const cause = error.cause;
  if (cause !== undefined && cause !== null) {
    console.error(`${prefix} cause:`, inspect(cause, { depth: 12, breakLength: 120, maxArrayLength: 50 }));
  }

  const meta = (error as { meta?: unknown }).meta;
  if (meta !== undefined) {
    console.error(`${prefix} meta:`, inspect(meta, { depth: 8, breakLength: 120 }));
  }

  const code = (error as { code?: unknown }).code;
  if (code !== undefined) {
    console.error(`${prefix} code:`, code);
  }
}
