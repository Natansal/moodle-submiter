/**
 * GCP e2-micro often has no IPv6 egress; Supabase may resolve to IPv6 first → ENETUNREACH.
 * Must load before any module that opens Postgres (ESM: keep this as the first import in index.ts).
 */
import { setDefaultResultOrder } from 'node:dns';

setDefaultResultOrder('ipv4first');
