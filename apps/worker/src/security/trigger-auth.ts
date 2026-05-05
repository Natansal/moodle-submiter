import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Performs a constant-time string comparison to prevent timing attacks
 * when verifying secrets or tokens.
 */
export function constantTimeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extracts the Bearer token from the Authorization header.
 * Returns `null` if the header is missing or malformed.
 */
export function readBearerToken(req: Request): string | null {
  const raw = req.get('authorization');
  if (!raw || !raw.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  return raw.slice(7).trim();
}

/** Normalize IPv4-mapped IPv6 and trim for comparison against allowlists. */
export function normalizeIpForWhitelist(ip: string): string {
  const t = ip.trim();
  if (t.startsWith('::ffff:')) {
    return t.slice(7);
  }
  return t;
}

/**
 * Checks whether a client IP address appears in the provided allowlist.
 * Normalizes IPv4-mapped IPv6 addresses before comparison.
 */
export function isInvokerIpAllowed(clientIp: string, allowed: readonly string[]): boolean {
  const n = normalizeIpForWhitelist(clientIp);
  return allowed.some((a) => normalizeIpForWhitelist(a) === n);
}

/**
 * Client IP for allowlisting: left-most X-Forwarded-For entry when present (Cloud Run / proxies).
 */
export function getTriggerClientIp(req: Request): string {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return normalizeIpForWhitelist(first);
    }
  }
  const socketIp = req.socket.remoteAddress;
  return socketIp ? normalizeIpForWhitelist(socketIp) : '';
}
