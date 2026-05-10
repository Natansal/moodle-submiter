import { jidNormalizedUser, type WASocket } from '@whiskeysockets/baileys';
import type { PrivateMonitor } from '@repo/redis';

export type { PrivateMonitor } from '@repo/redis';

export function partitionMonitoredIds(ids: string[]): { groups: string[]; privateJids: string[] } {
  const groups = ids.filter((id) => id.endsWith('@g.us'));
  const privateJids = ids.filter((id) => !id.endsWith('@g.us'));
  return { groups, privateJids };
}

export function expandedMonitoredJids(groups: string[], monitors: PrivateMonitor[]): string[] {
  const set = new Set<string>();
  for (const g of groups) set.add(g);
  for (const m of monitors) {
    for (const a of m.aliases) set.add(a);
  }
  return [...set];
}

export function parsePrivateMonitors(raw: unknown): PrivateMonitor[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PrivateMonitor[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = (item as { source?: unknown }).source;
    const aliases = (item as { aliases?: unknown }).aliases;
    if (typeof source !== 'string' || !Array.isArray(aliases)) continue;
    const aliasStrs = aliases.filter((a): a is string => typeof a === 'string');
    if (aliasStrs.length === 0) continue;
    out.push({ source, aliases: [...new Set(aliasStrs)] });
  }
  return out.length ? out : null;
}

export function mergeMonitorsBySource(monitors: PrivateMonitor[]): PrivateMonitor[] {
  const map = new Map<string, Set<string>>();
  for (const m of monitors) {
    if (!map.has(m.source)) map.set(m.source, new Set());
    const s = map.get(m.source)!;
    for (const a of m.aliases) s.add(a);
  }
  return [...map.entries()].map(([source, set]) => ({ source, aliases: [...set] }));
}

export function legacyMonitorsFromPrivateJids(privateJids: string[]): PrivateMonitor[] {
  const out: PrivateMonitor[] = [];
  for (const jid of privateJids) {
    const n = jidNormalizedUser(jid) ?? jid;
    out.push({ source: n, aliases: [n] });
  }
  return mergeMonitorsBySource(out);
}

async function addLidPnAliases(sock: WASocket | undefined, jid: string, into: Set<string>): Promise<void> {
  const n = jidNormalizedUser(jid) ?? jid;
  into.add(n);
  if (!sock) return;
  try {
    const { lidMapping } = sock.signalRepository;
    if (n.endsWith('@lid')) {
      const pn = await lidMapping.getPNForLID(n);
      if (pn) {
        const p = jidNormalizedUser(pn);
        if (p) {
          into.add(p);
          const lid = await lidMapping.getLIDForPN(p);
          if (lid) {
            const l = jidNormalizedUser(lid);
            if (l) into.add(l);
          }
        }
      }
    } else if (n.endsWith('@s.whatsapp.net')) {
      const lid = await lidMapping.getLIDForPN(n);
      if (lid) {
        const l = jidNormalizedUser(lid);
        if (l) into.add(l);
      }
    }
  } catch {
    // mapping unavailable
  }
}

export async function canonicalPrivateSource(sock: WASocket | undefined, jid: string): Promise<string> {
  const n = jidNormalizedUser(jid) ?? jid;
  if (!sock || !n.endsWith('@lid')) return n;
  try {
    const pn = await sock.signalRepository.lidMapping.getPNForLID(n);
    if (pn) {
      const p = jidNormalizedUser(pn);
      if (p) return p;
    }
  } catch {}
  return n;
}

export async function buildPrivateMonitors(
  sock: WASocket | undefined,
  privateJids: string[],
): Promise<PrivateMonitor[]> {
  const uniqInputs = [...new Set(privateJids.map((j) => jidNormalizedUser(j) ?? j))];
  const built: PrivateMonitor[] = [];
  for (const input of uniqInputs) {
    const source = await canonicalPrivateSource(sock, input);
    const aliases = new Set<string>();
    await addLidPnAliases(sock, source, aliases);
    await addLidPnAliases(sock, input, aliases);
    built.push({ source, aliases: [...aliases] });
  }
  return mergeMonitorsBySource(built);
}

export async function collectJidAliases(sock: WASocket | undefined, jid: string): Promise<string[]> {
  const into = new Set<string>();
  await addLidPnAliases(sock, jid, into);
  return [...into];
}

export function monitorsForDbRow(activeGroupIds: string[], privateMonitorsRaw: unknown): PrivateMonitor[] {
  const { privateJids } = partitionMonitoredIds(activeGroupIds);
  const parsed = parsePrivateMonitors(privateMonitorsRaw);
  if (parsed && parsed.length > 0) return parsed;
  return legacyMonitorsFromPrivateJids(privateJids);
}

export function expandedFromDbRow(activeGroupIds: string[], privateMonitorsRaw: unknown): string[] {
  const { groups } = partitionMonitoredIds(activeGroupIds);
  const monitors = monitorsForDbRow(activeGroupIds, privateMonitorsRaw);
  return expandedMonitoredJids(groups, monitors);
}

export async function jidsShareIdentity(sock: WASocket | undefined, a: string, b: string): Promise<boolean> {
  const A = await collectJidAliases(sock, a);
  const B = await collectJidAliases(sock, b);
  const setA = new Set(A);
  return B.some((x) => setA.has(x));
}
