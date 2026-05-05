# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS pruner
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@^2 prune @app/worker --docker

FROM mcr.microsoft.com/playwright:v1.59.1-noble AS builder
RUN corepack enable
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
RUN pnpm turbo run build --filter=@app/worker
RUN pnpm prune --prod

FROM mcr.microsoft.com/playwright:v1.59.1-noble AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /repo/apps/worker/dist ./apps/worker/dist
COPY --from=builder /repo/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/package.json ./package.json
WORKDIR /app/apps/worker
EXPOSE 8080
CMD ["node", "dist/index.js"]
