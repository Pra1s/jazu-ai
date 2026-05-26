# syntax=docker/dockerfile:1.7
# ─── Jazu Jobs Worker (BullMQ consumer для wa:inbound) ────────────────────
# Не имеет HTTP-эндпойнтов. Запускается как фоновый сервис, обрабатывает
# LLM-вызовы из очереди wa:inbound и кладёт reply в wa:outbound.
# Масштабирование: deploy.replicas N (несколько одинаковых контейнеров).

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat \
    && corepack enable \
    && corepack prepare pnpm@11.3.0 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json             apps/api/package.json
COPY apps/web/package.json             apps/web/package.json
COPY apps/wa-worker/package.json       apps/wa-worker/package.json
COPY apps/jobs/package.json            apps/jobs/package.json
COPY packages/db/package.json          packages/db/package.json
COPY packages/ai/package.json          packages/ai/package.json
COPY packages/shared/package.json      packages/shared/package.json
COPY packages/queue/package.json       packages/queue/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/wa-pipeline/package.json packages/wa-pipeline/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules            ./node_modules
COPY --from=deps /app/apps/jobs/node_modules  ./apps/jobs/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/jobs apps/jobs
RUN pnpm --filter @jazu/db exec prisma generate

FROM base AS runner
ENV NODE_ENV=production

# См. комментарий в apps/api/Dockerfile: копируем node_modules per-package,
# чтобы Node нашёл транзитные зависимости workspace-пакетов в runtime.
COPY --from=builder /app/packages                         ./packages
COPY --from=builder /app/apps/jobs                        ./apps/jobs
COPY --from=builder /app/node_modules                     ./node_modules
COPY --from=builder /app/apps/jobs/node_modules           ./apps/jobs/node_modules
COPY --from=builder /app/packages/db/node_modules         ./packages/db/node_modules
COPY --from=deps    /app/packages/ai/node_modules         ./packages/ai/node_modules
COPY --from=deps    /app/packages/queue/node_modules      ./packages/queue/node_modules
COPY --from=deps    /app/packages/observability/node_modules ./packages/observability/node_modules
COPY --from=deps    /app/packages/shared/node_modules     ./packages/shared/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./

USER node
CMD ["node", "--import", "tsx/esm", "apps/jobs/src/index.ts"]
