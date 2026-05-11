import prismaPkg from '../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

export type { Prisma } from '../generated/prisma/index.js';

export const PrismaClient = prismaPkg.PrismaClient;
export type PrismaClient = InstanceType<typeof prismaPkg.PrismaClient>;

export { usePrismaAuthState } from './use-prisma-auth-state.js';

let prismaInstance: PrismaClient | undefined;
let initPromise: Promise<void> | undefined;

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

async function resolveIpv4(hostname: string): Promise<string | null> {
  const bare = stripIpv6Brackets(hostname);
  const ipVer = net.isIP(bare);
  if (ipVer === 4) return bare;
  if (ipVer === 6) return null;
  try {
    const records = await dns.resolve4(bare);
    if (records.length > 0) {
      return records[0];
    }
  } catch {
    // ENOTFOUND / ENODATA — try lookup fallback (different resolver path on some hosts)
  }
  try {
    const { address } = await dns.lookup(bare, { family: 4 });
    return address;
  } catch {
    return null;
  }
}

function shouldUseSsl(hostname: string, sslmode: string | null): boolean {
  if (sslmode === 'disable') return false;
  if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    return true;
  }
  return hostname.endsWith('.supabase.co') || hostname.endsWith('.pooler.supabase.com');
}

/** Default true. Set DATABASE_SSL_REJECT_UNAUTHORIZED=0 only for debugging (insecure). */
function tlsRejectUnauthorized(): boolean {
  const v = process.env.DATABASE_SSL_REJECT_UNAUTHORIZED;
  if (v === '0' || v === 'false') return false;
  return true;
}

/**
 * When TCP connects to an IPv4 address, TLS must still verify the pooler hostname on the cert.
 * Also avoids pg/openssl verifying against the IP literal.
 */
function pgSslOptions(hostnameForCert: string): pg.ConnectionConfig['ssl'] {
  const rejectUnauthorized = tlsRejectUnauthorized();
  return {
    rejectUnauthorized,
    servername: hostnameForCert,
    checkServerIdentity: (_hostname, cert) => tls.checkServerIdentity(hostnameForCert, cert),
  };
}

async function createPrisma(): Promise<PrismaClient> {
  const datasourceUrl = process.env.DATABASE_URL;
  if (!datasourceUrl) {
    throw new Error('DATABASE_URL is required for PrismaClient initialization');
  }

  const u = new URL(datasourceUrl);
  const hostname = stripIpv6Brackets(u.hostname);
  const port = u.port || '5432';
  if (hostname.endsWith('.pooler.supabase.com') && port === '6543') {
    console.warn(
      '[database] Using *.pooler.supabase.com:6543 — Supabase session pooler normally uses :5432 with user postgres.<PROJECT_REF>. ' +
        'Transaction mode (6543) often needs extra Prisma/PgBouncer settings; prefer the Session pooler string from the dashboard.',
    );
  }
  const ipKind = net.isIP(hostname);
  const ipv4 = await resolveIpv4(u.hostname);
  const sslmode = u.searchParams.get('sslmode');
  const useSsl = shouldUseSsl(hostname, sslmode);

  // Connecting by hostname lets pg pick AAAA first on many hosts → ENETUNREACH on IPv4-only VMs.
  // Supabase "direct connection" host db.<ref>.supabase.co is often IPv6-only (no A record).
  // IPv4-only servers must use the Session or Transaction pooler URL from the dashboard instead.
  if (ipKind === 0 && !ipv4) {
    const directDbHost = /^db\.[a-z0-9]+\.supabase\.co$/i.test(hostname);
    if (directDbHost) {
      throw new Error(
        `[database] Host "${hostname}" has no IPv4 address (Supabase direct DB is IPv6-only). ` +
          `Use an IPv4-capable URL: Dashboard → Connect → Session pooler ` +
          `(…pooler.supabase.com:5432, user postgres.<PROJECT_REF>).`,
      );
    }
    throw new Error(
      `[database] No IPv4 address for Postgres host "${hostname}". ` +
        `Use a host with an A record, or for Supabase use the session pooler (…pooler.supabase.com:5432).`,
    );
  }

  const useIpv4Pool = ipKind === 0 && ipv4 != null;

  if (useIpv4Pool) {
    console.info(`[database] Postgres via IPv4 ${ipv4} (host ${hostname})`);
    const pool = new pg.Pool({
      connectionString: datasourceUrl,
      host: ipv4,
      ssl: useSsl ? pgSslOptions(hostname) : undefined,
    });
    const adapter = new PrismaPg(pool, { disposeExternalPool: true });
    return new prismaPkg.PrismaClient({ adapter });
  }

  const adapter = new PrismaPg({ connectionString: datasourceUrl });
  return new prismaPkg.PrismaClient({ adapter });
}

export async function initDatabase(): Promise<void> {
  if (prismaInstance) return;
  if (!initPromise) {
    initPromise = (async () => {
      prismaInstance = await createPrisma();
      await prismaInstance.$connect();
    })();
  }
  try {
    await initPromise;
  } catch (error) {
    initPromise = undefined;
    throw error;
  }
}

export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    throw new Error('initDatabase() must be called before getPrismaClient()');
  }

  return prismaInstance;
}
