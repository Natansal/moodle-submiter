# @app/worker

HTTP worker service that receives authenticated webhook triggers and automates Moodle SSO login via a headless Playwright browser.

## Architecture

```
src/
├── index.ts              Entry point — loads config, starts server, handles graceful shutdown
├── config.ts             Environment validation & typed configuration
├── app.ts                Express app factory (middleware + routes)
├── routes/
│   └── trigger.route.ts  POST /trigger handler (auth → validate → automate)
├── middleware/
│   └── boom-error-handler.ts  Centralised Boom / catch-all error handler
├── services/
│   ├── moodle-automation.service.ts   Playwright-based Moodle login automation
│   └── lock.service.ts                Upstash Redis distributed deduplication lock (24h TTL)
├── security/
│   ├── trigger-auth.ts                Bearer token & IP authentication helpers
│   └── trigger-security.constants.ts  IP and hostname allowlists
├── validation/
│   └── payload.validation.ts          Request body type-guard & host validation
└── utils/
    └── random.ts                      Random integer helper for human-like delays
scripts/
└── encrypt-body.ts       Dev utility — encrypts credentials and copies JSON payload to clipboard
```

## Prerequisites

- Node.js 20+
- pnpm (workspace root)
- Playwright system dependencies (installed automatically in Docker via the Playwright base image)

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRIGGER_SHARED_SECRET` | Yes | Shared secret for Bearer token authentication |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST endpoint for distributed locks |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST auth token |
| `CREDENTIALS_ENCRYPTION_KEY` | Yes | Base64-encoded 256-bit key for decrypting credential payloads |
| `PORT` | No | HTTP listen port (default: `8080`) |
| `NODE_ENV` | No | `production` for headless mode; anything else enables headed browser |

## Scripts

```bash
# Development (watch mode)
pnpm dev

# Build TypeScript
pnpm build

# Start production server
pnpm start

# Encrypt credentials and copy JSON payload to clipboard
pnpm encrypt-body <targetUrl> <email> <password>
```

## API

### `POST /trigger`

Accepts an encrypted Moodle credential payload and runs browser automation before responding (keeps CPU allocated on serverless until Playwright finishes).

**Headers:**
- `Authorization: Bearer <TRIGGER_SHARED_SECRET>`

**Body:**
```json
{
  "targetUrl": "https://moodle.huji.ac.il/...",
  "credentials": { "iv": "...", "ciphertext": "...", "tag": "..." },
  "mode": "production"
}
```

**Responses:**
- `200` with `{ "ok": true }` — Automation completed successfully
- `500` with `{ "ok": false, "error": "<message>" }` — Automation failed (lock released so the trigger can be retried)
- `202` with `{ "accepted": true, "duplicate": true }` — Already processed (dedup lock; no new run)
- `400` — Invalid payload or decryption failure
- `401` — Missing/invalid Bearer token
- `403` — Client IP not in allowlist
- `500` (no `ok` field, via error handler) — Lock service or other internal failure before automation runs

On Cloud Run, set **request timeout** above your worst-case Playwright duration (up to 3600s); the HTTP response is withheld until automation finishes.

### `GET /healthz`

Returns `200 ok` for container health checks.

## Docker

```bash
# Build from monorepo root
docker build -f apps/worker/Dockerfile -t worker .
```

The Dockerfile uses a multi-stage build with Turbo pruning and the official Playwright base image.
