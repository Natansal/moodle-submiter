# syntax=docker/dockerfile:1.7
#
# Google Cloud Run — @app/worker (pnpm monorepo)
#
# Context must be the repository root (see cloudbuild.yaml).
#
# Layout:
#   1. turbo prune — minimal workspace slice for faster installs & cache reuse
#   2. pnpm install + turbo build — TypeScript needs devDependencies for compilation
#   3. pnpm deploy — production-only deploy folder with correct workspace linking
#      (avoids root `pnpm prune --prod`, which breaks monorepo symlinks)
#   4. playwright install chromium — binaries under PLAYWRIGHT_BROWSERS_PATH
#
# Playwright base image supplies OS deps for Chromium; tag matches package.json.
# Optional local run: docker run --init --ipc=host … (see Playwright Docker docs)

ARG PNPM_VERSION=9.15.0
ARG PLAYWRIGHT_IMAGE_TAG=v1.59.1-noble

# ─── Slice — turbo prune for Docker ───────────────────────────────────────────
FROM node:20-bookworm-slim AS pruner
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@^2 prune @app/worker --docker

# ─── Build — install (incl. devDeps), compile, deploy artifact ──────────────
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_IMAGE_TAG} AS builder
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo
ENV CI=true

COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ ./

RUN pnpm turbo run build --filter=@app/worker

# Isolated production bundle (workspace packages embedded correctly).
RUN pnpm --filter @app/worker deploy -P /deploy/worker

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN mkdir -p /opt/pw-browsers \
    && cd /deploy/worker \
    && npx playwright install chromium

# ─── Runtime — deploy dir + browser cache only ──────────────────────────────
ARG PLAYWRIGHT_IMAGE_TAG=v1.59.1-noble
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_IMAGE_TAG} AS runner

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

WORKDIR /app

COPY --from=builder --chown=pwuser:pwuser /deploy/worker /app
COPY --from=builder --chown=pwuser:pwuser /opt/pw-browsers /opt/pw-browsers

USER pwuser

EXPOSE 8080

CMD ["node", "dist/index.js"]
