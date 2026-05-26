# syntax=docker/dockerfile:1.7
# ─── Jazu API ─────────────────────────────────────────────────────────────
# Multi-stage: deps → builder (prisma generate) → runner (tsx/esm).
# Запускается через tsx без эмита — короче и проще, чем tsc + node dist.

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat \
    && corepack enable \
    && corepack prepare pnpm@11.3.0 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

# ── Stage 1: install зависимости всего workspace ──────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json            apps/api/package.json
COPY apps/web/package.json            apps/web/package.json
COPY apps/wa-worker/package.json      apps/wa-worker/package.json
COPY apps/jobs/package.json           apps/jobs/package.json
COPY packages/db/package.json         packages/db/package.json
COPY packages/ai/package.json         packages/ai/package.json
COPY packages/shared/package.json     packages/shared/package.json
COPY packages/queue/package.json      packages/queue/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/wa-pipeline/package.json packages/wa-pipeline/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: prisma generate (нужен только Prisma client) ─────────────────
FROM base AS builder
COPY --from=deps /app/node_modules            ./node_modules
COPY --from=deps /app/apps/api/node_modules   ./apps/api/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/api  apps/api
RUN pnpm --filter @jazu/db exec prisma generate

# ── Stage 3: lean runner ──────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3001

# Прокидываем generated Prisma + полное дерево исходников (apps/api запускается через tsx).
# Порядок имеет значение: сначала копируем сорцы packages из builder (там
# Prisma client уже сгенерён в packages/db/node_modules), затем поверх кладём
# node_modules per-package из deps. pnpm hoist'ит общие deps в корневые
# node_modules, но per-package symlinks на конкретные версии в .pnpm-store
# живут в node_modules самих пакетов. Без них Node не находит транзитные deps
# (типа @sentry/node, ioredis, bullmq) при импорте через @jazu/*.
COPY --from=builder /app/packages                         ./packages
COPY --from=builder /app/apps/api                         ./apps/api
COPY --from=builder /app/node_modules                     ./node_modules
COPY --from=builder /app/apps/api/node_modules            ./apps/api/node_modules
COPY --from=builder /app/packages/db/node_modules         ./packages/db/node_modules
COPY --from=deps    /app/packages/ai/node_modules         ./packages/ai/node_modules
COPY --from=deps    /app/packages/queue/node_modules      ./packages/queue/node_modules
COPY --from=deps    /app/packages/observability/node_modules ./packages/observability/node_modules
COPY --from=deps    /app/packages/shared/node_modules     ./packages/shared/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./

# Скрипт-обёртка: сначала migrate deploy, потом запуск API.
# Если миграция упадёт — контейнер тоже упадёт (restart policy перезапустит).
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'cd /app/packages/db && node_modules/.bin/prisma migrate deploy' \
    'cd /app/apps/api && exec node --import tsx/esm src/index.ts' \
    > /usr/local/bin/run-api.sh \
    && chmod +x /usr/local/bin/run-api.sh

EXPOSE 3001
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- http://127.0.0.1:3001/healthz 2>/dev/null || exit 1
CMD ["/usr/local/bin/run-api.sh"]
