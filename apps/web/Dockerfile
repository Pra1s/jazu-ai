# syntax=docker/dockerfile:1.7
# ─── Jazu Web (Next.js 16, standalone output) ─────────────────────────────

FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat \
    && corepack enable \
    && corepack prepare pnpm@11.3.0 --activate
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV CI=1

# ── Stage 1: install ──────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json            apps/api/package.json
COPY apps/web/package.json            apps/web/package.json
COPY apps/wa-worker/package.json      apps/wa-worker/package.json
COPY packages/db/package.json         packages/db/package.json
COPY packages/ai/package.json         packages/ai/package.json
COPY packages/shared/package.json     packages/shared/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── Stage 2: next build ───────────────────────────────────────────────────
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* зашиваются в бандл на этапе билда. Передавайте через --build-arg.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
# PostHog: токен публичный (phc_...), зашивается в клиентский бандл.
ARG NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=$NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST

COPY --from=deps /app/node_modules            ./node_modules
COPY --from=deps /app/apps/web/node_modules   ./apps/web/node_modules
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps/web  apps/web
RUN pnpm --filter @jazu/web build

# ── Stage 3: lean runner ──────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Next standalone output содержит весь нужный код + минимальные node_modules.
# .next/static и public копируем отдельно.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
# public/ может отсутствовать (если не используется). Создаём пустой каталог,
# чтобы Next standalone не падал при попытке его обслужить.
RUN mkdir -p ./apps/web/public

EXPOSE 3000
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD wget -qO- http://127.0.0.1:3000 >/dev/null 2>&1 || exit 1
CMD ["node", "apps/web/server.js"]
