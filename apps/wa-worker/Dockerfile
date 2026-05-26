# syntax=docker/dockerfile:1.7
# ─── Jazu WA Worker (Baileys, auth state в Postgres через API) ────────────

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat \
    && corepack enable \
    && corepack prepare pnpm@11.3.0 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

# ── Stage 1: install ──────────────────────────────────────────────────────
# Объявляем ВСЕ workspace-проекты до pnpm install. Если пропустить хоть один
# (типа packages/observability), pnpm не создаст для него symlinks внутри
# `node_modules/.pnpm/`, и зависимые пакеты при runtime не смогут найти
# его транзитные зависимости (`Cannot find package '@sentry/node'`).
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

# ── Stage 2: lean runner ──────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=4001

# Прокидываем node_modules КАЖДОГО workspace-пакета, который wa-worker
# импортирует (или импортирует транзитивно). pnpm hoist'ит общие deps в
# /app/node_modules, но per-package symlinks (на конкретные версии в
# /app/node_modules/.pnpm/...) живут в node_modules самих пакетов.
COPY --from=deps /app/node_modules                       ./node_modules
COPY --from=deps /app/apps/wa-worker/node_modules        ./apps/wa-worker/node_modules
COPY --from=deps /app/packages/queue/node_modules        ./packages/queue/node_modules
COPY --from=deps /app/packages/observability/node_modules ./packages/observability/node_modules
COPY --from=deps /app/packages/shared/node_modules       ./packages/shared/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/wa-worker apps/wa-worker

EXPOSE 4001
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- http://127.0.0.1:4001/health >/dev/null 2>&1 || exit 1
CMD ["node", "--import", "tsx/esm", "apps/wa-worker/src/index.ts"]
