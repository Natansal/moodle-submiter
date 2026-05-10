# syntax=docker/dockerfile:1.7
#
# Build from the monorepo root:
#   docker build -f apps/listener/Dockerfile .

FROM node:22-alpine AS pruner
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@^2 prune @app/listener --docker

FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat git \
  && corepack enable \
  && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
# TODO; real URL must be supplied at runtime (see packages/database prisma.config.ts)
ENV DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder
RUN pnpm --filter @repo/database exec prisma generate \
  && pnpm turbo run build --filter=@app/listener \
  && pnpm prune --prod

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache libc6-compat
COPY --from=builder /repo/apps/listener/dist ./apps/listener/dist
COPY --from=builder /repo/apps/listener/package.json ./apps/listener/package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/package.json ./package.json
WORKDIR /app/apps/listener
EXPOSE 3001
CMD ["node", "dist/index.js"]
