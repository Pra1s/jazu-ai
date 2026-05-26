# Jazu

[![CI](https://github.com/Pra1s/jazu-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/Pra1s/jazu-ai/actions/workflows/ci.yml)

Chatera-like MVP for generic businesses: chat-based AI prompt builder, test sandbox, WhatsApp QR connect, chats, leads and settings.

## Workspace

- `apps/web` — Next.js app (App Router)
- `apps/api` — Fastify API + Prisma. Сам LLM не вызывает в продакшене — только кладёт задачи в Redis.
- `apps/wa-worker` — Baileys WhatsApp worker. Принимает входящие, кладёт в `wa:inbound`, потребляет `wa:outbound`.
- `apps/jobs` — BullMQ-consumer для `wa:inbound`. Здесь живёт тяжёлая логика LLM + БД. Масштабируется горизонтально.
- `packages/db` — Prisma schema and client
- `packages/ai` — prompt builders and runtime logic (вызовы OpenAI)
- `packages/queue` — BullMQ-фабрики (Redis, очереди, воркеры)
- `packages/wa-pipeline` — общий handler входящего WA-сообщения + биллинг (импортируется и api, и jobs)
- `packages/shared` — shared schemas and types

## Run locally

Три варианта запуска:

### A) Гибрид (по умолчанию, самый быстрый hot-reload)

БД в Docker, приложения — хост-процессы:

```bash
cp .env.example .env       # положите свой OPENAI_API_KEY
pnpm setup                 # install + поднять Postgres/Redis + migrate deploy + prisma generate
pnpm dev                   # параллельно API (3001) + web (3000) + wa-worker (4001)
```

### B) Всё в Docker (одна команда, с hot-reload)

```bash
cp .env.example .env       # OPENAI_API_KEY обязательно
pnpm docker:dev:up         # postgres + redis + api + web + wa-worker в контейнерах
pnpm docker:dev:logs       # tail логи
pnpm docker:dev:down       # остановить (данные БД сохранятся)
pnpm docker:dev:reset      # ОПАСНО: down -v, удаляет pgdata/redisdata
```

Первый `up` качает зависимости в named volumes (1-3 минуты). Дальше — hot-reload через `tsx watch` (API/worker) и `next dev` (web). Изменения файлов на хосте мгновенно видны в контейнерах.

Открывается на тех же портах: http://localhost:3000 (web), http://localhost:3001/api (api), http://localhost:4001 (wa-worker).

> Если на хосте параллельно запущен `pnpm dev` — будет конфликт портов. Остановите его перед `docker:dev:up`.

### C) Прод-стек локально (для финального теста)

```bash
cp .env.prod.example .env  # заполнить ВСЕ обязательные секреты
pnpm docker:prod:build
pnpm docker:prod:up
```

См. [DEPLOY.md](./DEPLOY.md) — там подробно про caddy/https/домены.

Что делает `pnpm setup`:

1. `pnpm install`
2. `pnpm db:up` — поднимает Postgres и Redis в Docker (`docker-compose.yml`)
3. `pnpm db:deploy` — накатывает миграции (`prisma migrate deploy`, без shadow DB и без интерактива)
4. `pnpm db:generate` — генерирует Prisma client

После этого `pnpm dev` запускает все три приложения. Веб открывается на http://localhost:3000.

Полезные команды:

- `pnpm db:migrate` — `prisma migrate dev` для разработки (создаёт новую миграцию, использует shadow DB)
- `pnpm db:deploy` — `prisma migrate deploy` для прода/CI (только применяет существующие миграции)
- `pnpm db:studio` — Prisma Studio
- `pnpm db:up:full` — поднять Postgres, Redis **и** wa-worker в Docker (профиль `full`)
- `pnpm db:down` — остановить docker-сервисы

## Required env (см. `.env.example`)

Обязательны всегда:

- `DATABASE_URL`
- `WEB_ORIGIN`, `API_ORIGIN`, `NEXT_PUBLIC_API_BASE_URL`
- `API_INTERNAL_TOKEN`, `MAGIC_LINK_SECRET`
- `WA_WORKER_URL`

Опциональны в dev, **обязательны в production**:

- `OPENAI_API_KEY`
- `RESEND_API_KEY`, `FROM_EMAIL` (без них magic link не доходит до пользователя)

В production `apps/api/src/env.ts` падает на старте, если `MAGIC_LINK_SECRET` или `API_INTERNAL_TOKEN` равны dev-дефолтам, или если отсутствуют любые из перечисленных production-секретов. Это fail-fast.

## Deploy to production

Полная инструкция: **[DEPLOY.md](./DEPLOY.md)** — Docker Compose + Caddy + Let's Encrypt, всё в контейнерах, миграции автоматом.

Минимальный чек-лист:

1. Сгенерировать секреты:
   ```bash
   openssl rand -hex 32   # MAGIC_LINK_SECRET
   openssl rand -hex 32   # API_INTERNAL_TOKEN
   ```
2. Выставить все ENV из `.env.example`; убедиться, что `NODE_ENV=production`.
3. Прогнать миграции:
   ```bash
   pnpm db:deploy
   ```
4. Собрать и запустить:
   ```bash
   pnpm build
   pnpm --filter @jazu/api start
   pnpm --filter @jazu/web start
   pnpm --filter @jazu/wa-worker start
   ```
   Либо через Docker (`apps/api/Dockerfile`, `apps/web/Dockerfile`, `apps/wa-worker/Dockerfile`).
5. Настроить backup Postgres.
6. Если когда-либо коммитили `.env` — ротировать `OPENAI_API_KEY` в OpenAI dashboard и `RESEND_API_KEY` в Resend.

## Architecture notes

- **Auth.** Два пути логина:
  - **Email + phone (magic link)** — `POST /auth/magic-link { email, phone }`. Номер валидируется как KZ/RU (+7XXXXXXXXXX), сохраняется в `MagicLinkToken.phoneSnapshot`, при `GET /auth/callback?token=…` атомарно консьюмится (one-time-use) и записывается в `User.phone`.
  - **Google OAuth** (`GET /auth/google/start` → consent → `/auth/google/callback`). PKCE-S256, state в короткоживущей httpOnly cookie. После успешной авторизации, если у юзера ещё нет `phone`, редиректит на `/auth/phone` для добивки номера; иначе — в `/dashboard`. Поддерживается merge: если email уже существует, бэк апсёртит `googleId/avatarUrl`.
  - Источник истины пользователя — `Session.userId` в Postgres. Cookie `jazu_session_id` — opaque UUID, без подписи (вся семантика в БД). При логине ротируем `cookieId` (защита от session fixation).
- **WhatsApp pipeline (production).**

  ```
  Baileys messages.upsert
        │  (Baileys event loop не блокируется)
        ▼  enqueue
  ┌──────────────┐
  │  wa:inbound  │   ◄── BullMQ + Redis
  └──────┬───────┘
         │ apps/jobs consumer (concurrency=10): dedupe + квота + LLM + persist
         ▼
  ┌──────────────┐
  │  wa:outbound │
  └──────┬───────┘
         │ apps/wa-worker consumer (concurrency=8, rate-limit per-chatId)
         ▼
   socket.sendMessage()
  ```

  - Все тяжёлые операции (LLM-вызовы, БД-запись, лиды) — в `apps/jobs`, который скейлится горизонтально просто запуском ещё одного контейнера.
  - Baileys event loop полностью «холодный»: только enqueue + sendMessage. Это критично для стабильности WhatsApp-сокета при сотнях одновременных входящих.
  - Идемпотентность: `jobId = wa:<agentId>:<waMessageId>` гарантирует, что один и тот же inbound не обрабатывается дважды даже при ретраях Baileys или рестартe worker'а.
  - Retry + exponential backoff встроены в BullMQ (5 попыток, 2с/4с/8с/16с/32с).
  - Auth state Baileys хранится в `WaConnection.authState` (Postgres), читается через `/api/internal/wa-auth/:agentId`. Воркер не пишет на диск.
  - Fallback: если `REDIS_URL` не выставлен — wa-worker откатывается на старый синхронный HTTP-путь (только для dev без Redis; в проде не использовать).
- **Graceful shutdown.** API/wa-worker/jobs ловят `SIGTERM`/`SIGINT`, дожидаются завершения in-flight HTTP-запросов и BullMQ-задач, потом закрывают Redis. Hard exit через 30с, чтобы зависшие SSE не блокировали деплой.
- **Prompt lifecycle.** LLM сам решает событие (`skip`/`create`/`edit`/`correction`); API только сохраняет `PromptVersion`. Коррекции в test-mode переключают пользователя в setup-chat с зелёной diff-карточкой.

## Layered roadmap

- **Level 1:** security/production-hardening (`.cursor/plans/level1_*`).
- **Level 2 — v1.0 readiness:**
  - **Спринт 1 (этот PR):** BullMQ-очереди, jobs worker, outbound rate-limit, graceful shutdown.
  - Спринт 2: per-user rate-limit, daily LLM-token budget, `LlmCallLog`, bot-loop protection.
  - Спринт 3: Sentry, request-IDs в SSE, расширенный healthcheck, cost alerts.
  - Спринт 4: CI (typecheck/lint/тесты), smoke e2e.
- **Level 3:** аналитика, лиды UI, мультиаккаунты.
