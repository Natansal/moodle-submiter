/**
 * IPs allowed to invoke POST /trigger (first hop in X-Forwarded-For when trust proxy is on,
 * else req.socket.remoteAddress). Add your listener host's public IPv4/IPv6 as needed.
 */
export const ALLOWED_TRIGGER_INVOKER_IPS: readonly string[] = [
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
];

/**
 * Hostnames allowed in WebhookPayload.targetUrl (prevents navigation to arbitrary origins).
 */
export const ALLOWED_TRIGGER_TARGET_HOSTS: readonly string[] = ['moodle.huji.ac.il'];
