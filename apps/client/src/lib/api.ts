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

export async function openQrStream(
  onQr: (qr: string) => void,
  onReady?: (connected: boolean) => void,
  onStreamError?: (message: string) => void,
): Promise<() => void> {
  const blocked = mixedContentError();
  if (blocked) {
    onStreamError?.(blocked);
    return () => {};
  }

  const headers = await authHeader();
  const token = headers.authorization.replace('Bearer ', '');
  const url = new URL(`${apiBase}/api/qr`);
  url.searchParams.set('access_token', token);

  const source = new EventSource(url.toString());
  source.addEventListener('qr', (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { qr: string };
    onQr(payload.qr);
  });
  source.addEventListener('ready', (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { connected: boolean };
    onReady?.(payload.connected);
  });
  source.onerror = () => {
    onStreamError?.('QR stream disconnected. Please refresh and try again.');
    source.close();
  };
  return () => source.close();
}
