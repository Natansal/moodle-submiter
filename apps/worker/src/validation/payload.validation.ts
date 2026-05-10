import type { WebhookPayload } from '@repo/shared-types';
import { ALLOWED_TRIGGER_TARGET_HOSTS } from '../security/trigger-security.constants.js';

/**
 * Type-guard that validates an unknown request body conforms to the
 * expected {@link WebhookPayload} shape (targetUrl + encrypted credentials).
 */
export function isValidWebhookPayload(body: unknown): body is WebhookPayload {
  if (!body || typeof body !== 'object') {
    return false;
  }
  const b = body as Record<string, unknown>;
  if (typeof b.targetUrl !== 'string') {
    return false;
  }
  const c = b.credentials;
  const hasEncryptedCredentials =
    !!c &&
    typeof c === 'object' &&
    typeof (c as Record<string, unknown>).iv === 'string' &&
    typeof (c as Record<string, unknown>).ciphertext === 'string' &&
    typeof (c as Record<string, unknown>).tag === 'string';

  return hasEncryptedCredentials;
}

/**
 * Checks whether the hostname of the given URL is present in the
 * configured allowlist, preventing navigation to arbitrary origins.
 */
export function isTargetHostAllowed(targetUrl: string): boolean {
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ALLOWED_TRIGGER_TARGET_HOSTS.some((h) => h.toLowerCase() === host);
}
