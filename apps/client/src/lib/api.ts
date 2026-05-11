import { supabase } from './supabase';

const apiBase = (import.meta.env.VITE_LISTENER_API_URL as string)?.replace(/\/$/, '');

if (!apiBase) {
  throw new Error('VITE_LISTENER_API_URL is required');
}

/** HTTPS pages cannot call http:// APIs (browser mixed-content policy). */
function mixedContentError(): string | null {
  if (typeof window === 'undefined') return null;
  if (window.location.protocol !== 'https:') return null;
  try {
    const u = new URL(apiBase);
    if (u.protocol === 'http:') {
      return (
        'This site uses HTTPS but VITE_LISTENER_API_URL is HTTP. Browsers block that. ' +
        'Serve the listener over HTTPS (nginx + Let’s Encrypt, Cloudflare Tunnel, GCP HTTPS LB, etc.), ' +
        'then set GitHub Actions secret VITE_LISTENER_API_URL to that https:// URL and redeploy the client.'
      );
    }
  } catch {
    return null;
  }
  return null;
}

async function guardMixedContent(): Promise<void> {
  const msg = mixedContentError();
  if (msg) throw new Error(msg);
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new Error('No session token available');
  }
  return { authorization: `Bearer ${token}` };
}

export async function fetchChats() {
  await guardMixedContent();
  const headers = await authHeader();
  const res = await fetch(`${apiBase}/api/chats`, { headers });
  if (!res.ok) throw new Error(`Failed to load chats (${res.status})`);
  return (await res.json()) as {
    chats: { id: string; subject: string; kind: 'group' | 'private' }[];
    sessionActive: boolean;
    message?: string;
  };
}

export async function fetchSettings() {
  await guardMixedContent();
  const headers = await authHeader();
  const res = await fetch(`${apiBase}/api/settings`, { headers });
  if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
  return (await res.json()) as { settings: unknown };
}

export async function saveSettings(payload: unknown) {
  await guardMixedContent();
  const headers = await authHeader();
  const res = await fetch(`${apiBase}/api/settings`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to save settings (${res.status})`);
}

const POLL_MS = 1500;
const POLL_CONNECTED_MS = 10_000;

export type QrPollController = { dispose: () => void; refresh: () => void };

/**
 * Polls `/api/qr/poll` (faster while waiting for QR, every 10s when connected). Returns `dispose` and `refresh`
 * synchronously so unmount can cancel in-flight work. Use only from the Setup page effect.
 */
export function openQrStream(
  onQr: (qr: string) => void,
  onReady?: (connected: boolean) => void,
  onStreamError?: (message: string) => void,
  onPollInFlight?: (inFlight: boolean) => void,
): QrPollController {
  const blocked = mixedContentError();
  if (blocked) {
    onStreamError?.(blocked);
    return { dispose: () => {}, refresh: () => {} };
  }

  let stopped = false;
  let intervalId: number | undefined;
  let scheduledMs = 0;
  let lastQr = '';
  let lastConnected: boolean | undefined;

  let tail: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>) => {
    tail = tail.then(fn).catch(() => {});
  };

  const currentPollMs = () => (lastConnected === true ? POLL_CONNECTED_MS : POLL_MS);

  const dispose = () => {
    stopped = true;
    if (intervalId !== undefined) {
      window.clearInterval(intervalId);
      intervalId = undefined;
    }
  };

  const startOrAdjustTimer = () => {
    if (stopped) return;
    const need = currentPollMs();
    if (intervalId !== undefined && scheduledMs === need) return;
    if (intervalId !== undefined) {
      window.clearInterval(intervalId);
      intervalId = undefined;
    }
    scheduledMs = need;
    intervalId = window.setInterval(() => {
      void enqueue(runPoll);
    }, scheduledMs) as unknown as number;
  };

  const runPoll = async () => {
    if (stopped) return;
    onPollInFlight?.(true);
    try {
      const headers = await authHeader();
      if (stopped) return;
      const res = await fetch(`${apiBase}/api/qr/poll`, { headers });
      if (stopped) return;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        if (!stopped) {
          onStreamError?.(`Could not reach WhatsApp service (${res.status})${text ? `: ${text}` : ''}`);
        }
        dispose();
        return;
      }
      const data = (await res.json()) as { qr: string | null; connected: boolean };
      if (stopped) return;
      if (data.qr && data.qr !== lastQr) {
        lastQr = data.qr;
        onQr(data.qr);
      }
      if (lastConnected === undefined || data.connected !== lastConnected) {
        lastConnected = data.connected;
        onReady?.(data.connected);
      }
    } catch (e) {
      if (!stopped) {
        onStreamError?.(e instanceof Error ? e.message : 'Network error while loading QR');
      }
      dispose();
    } finally {
      onPollInFlight?.(false);
    }
  };

  void enqueue(async () => {
    await runPoll();
    startOrAdjustTimer();
  });

  const refresh = () => {
    enqueue(async () => {
      if (stopped) return;
      if (intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
      await runPoll();
      startOrAdjustTimer();
    });
  };

  return { dispose, refresh };
}
