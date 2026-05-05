import 'dotenv/config';
import { encryptJson, getKeyFromEnv } from '@repo/shared-crypto';
import { execSync } from 'node:child_process';

const [targetUrl, email, password] = process.argv.slice(2);

if (!targetUrl || !email || !password) {
  console.error('Usage: pnpm --filter @app/worker encrypt-body <targetUrl> <email> <password>');
  process.exit(1);
}

const key = getKeyFromEnv();
const credentials = encryptJson({ email, password }, key);
const body = JSON.stringify({ targetUrl, credentials }, null, 2);

try {
  execSync('pbcopy', { input: body });
  console.log('Copied to clipboard:\n');
} catch {
  console.log('Could not copy to clipboard. Output:\n');
}

console.log(body);
