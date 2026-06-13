# Журнал багов

Хронология решённых багов: что случилось, почему, как решили. Новые записи —
сверху. Правила ведения см. в `.cursor/rules/bugfix-journal.mdc`.

## 2026-06-13 — apps/api не проходил typecheck (exactOptionalPropertyTypes)

- **Что случилось:** на `origin/main` `apps/api` падал typecheck — `routes.ts(1782)` и `routes.ts(2268)`, ошибка TS2379 на вызовах `resolveChatInput(body)`: `Type 'string | undefined' is not assignable to type 'string'`. В CI не ловилось (strict-typecheck по воркспейсу, видимо, не гоняется на пуше).
- **Почему:** регрессия от голосовой фичи (запись от 2026-06-12). `chatBodySchema.parse()` через zod даёт тип `{ message?: string | undefined; audioBase64?: string | undefined; mimeType?: string | undefined }`, а параметр `resolveChatInput` был описан как `{ message?: string; ... }` — без `| undefined`. При `exactOptionalPropertyTypes: true` (`tsconfig.base.json`) `message?: string` означает «строго `string`, не `undefined`», поэтому zod-тело не присваивалось.
- **Как решили:** параметр `resolveChatInput` типизирован прямо из схемы — `body: z.infer<typeof chatBodySchema>` (`apps/api/src/routes.ts`). Теперь тип параметра всегда совпадает с тем, что возвращает `parse()`, и не разъедется при изменениях схемы.
- **Как проверить / не повторить:** `pnpm --filter @jazu/api exec tsc --noEmit` — зелёный. При добавлении хелперов, принимающих результат `*.parse()` zod-схемы с опциональными полями, типизировать параметр через `z.infer<typeof schema>`, а не вручную (иначе из-за `exactOptionalPropertyTypes` всплывёт TS2379). Желательно добавить `tsc --noEmit` по воркспейсу в CI.

## 2026-06-12 — Голосовое в веб-чате как аудио-файл (а не текст)

- **Что случилось:** в веб-чате (настройка и тест) запись голосового шла через `/transcribe`, а распознанный текст просто вставлялся в поле ввода — пользователь отправлял его как обычное текстовое сообщение. Голосового как такового в ленте не было видно.
- **Почему:** `transcribeBlob` в `apps/web/components/chat-workspace.tsx` клал результат STT в `setInput`, а чат-эндпоинты (`/agent/chat`, `/test-chat/chat`) принимали только `{ message }`. Аудио нигде не сохранялось и не отображалось.
- **Как решили:** (1) в `messagePartSchema` (`packages/shared`) добавлены `audio_base64`/`audio_mime`. (2) `chatBodySchema` (`apps/api/src/routes.ts`) теперь принимает `message` ИЛИ `audioBase64`+`mimeType` (лимит ~6 МБ); общий хелпер `resolveChatInput` распознаёт аудио через `transcribeAudio` (для LLM), кладёт транскрипт в `content` (нужен истории/контексту), а в `parts` — аудио-часть. Оба эндпоинта (`/agent/chat`, `/test-chat/chat`) используют хелпер. (3) во фронте `transcribeBlob` заменён на `sendVoiceMessage`: голосовое сразу уходит в чат оптимистичным аудио-пузырём (плеер из data URL) и отправляется в SSE как `audioBase64`; `MessageRow` рендерит `<audio controls>` для user-сообщений с аудио-частью. Старый `/transcribe` остался, но фронтом больше не используется.
- **Как проверить / не повторить:** записать голосовое в «Настройке» и «Тесте» → в ленте появляется плеер (не текст), бот отвечает по смыслу; после reload плеер сохраняется (история отдаёт `parts` с base64). Только веб (`web`), бэкенд для STT — `api`. Текстовая отправка не затронута.

## 2026-06-12 — Распознавание голосовых в WhatsApp (STT)

- **Что случилось:** голосовые сообщения в WhatsApp полностью игнорировались — бот на них не отвечал. Текст из `audioMessage` нигде не извлекался: `getTextMessage` в `apps/wa-worker/src/manager.ts` обрабатывал только `conversation`/`extendedTextMessage`/подписи, а голосовое просто отбрасывалось (`if (!text) continue`).
- **Почему:** в пайплайне не было ни скачивания медиа, ни шага speech-to-text. `transcribeAudio` (`packages/ai/src/openai.ts`) существовал, но звался только из веб-эндпоинта `/transcribe` и был жёстко завязан на OpenAI Whisper.
- **Как решили:** (1) wa-worker ловит `audioMessage`, скачивает байты через Baileys `downloadMediaMessage` и кладёт их в очередь (`audioBase64`/`audioMimeType` в `WaInboundJob`, `packages/queue`). Guard по размеру ~25 МБ, лимита по длительности нет — принимаем практически любое аудио. (2) `processWaInbound` (`packages/wa-pipeline/src/handler.ts`) после dedupe распознаёт аудио в `messageText` и дальше обрабатывает как обычный текст; при неудаче распознавания сохраняет «[голосовое сообщение]» и мягко просит написать текстом (LLM не дёргает). (3) `transcribeAudio` сделан переключаемым: `STT_PROVIDER` (gemini по умолчанию) + второй провайдер как fallback; Gemini идёт через нативный `generateContent` с inline-аудио, OpenAI — через Whisper. Веб-`/transcribe` использует ту же функцию (тоже Gemini + fallback). (4) `STT_PROVIDER`/`STT_MODEL` проброшены в `api` и `jobs` (docker-compose.prod.yml, .env/.env.example).
- **Как проверить / не повторить:** отправить боту голосовое в WhatsApp → в БД появляется inbound с распознанным текстом, бот отвечает по смыслу; длинные голосовые тоже принимаются; при пустом `GEMINI_API_KEY` срабатывает OpenAI-fallback. Деплоить `wa-worker` (скачивание медиа), `jobs` и `api` (STT внутри wa-pipeline — прод-путь в jobs, legacy в api). Транскрипция идёт ПОСЛЕ dedupe/квоты, чтобы не платить за STT по дублям.

## 2026-06-12 — extra-data затирал профиль, заморозка carcass, эскалация жалобы

- **Что случилось:** (1) Форма «Данные о бизнесе»: владелец заполнял одно поле и сохранял → остальной собранный профиль (услуги, прайс, часы, ограничения) вычищался, `isProfileReadyForPrompt` слетал в false, `readyToFinalize` сбрасывался (промпт при этом оставался цел). (2) У агентов с выездной нишей (клининг/грузоперевозки) каркас фиксировался по ПЕРВОМУ ходу билдера (`inspection`) вместо финального (`lead_capture`) — механика «закрыть на осмотр» вместо «собрать заявку». (3) Жалоба, пришедшая ПОСЛЕ горячего лида, не уведомляла владельца до закрытия лида.
- **Почему:** (1) В `apps/api/src/routes.ts` обработчик `/agent/extra-data` строил patch по проверке `!== undefined`, а форма шлёт все поля всегда (пустые — `""`); `mergeProfile` (`packages/ai/src/prompts.ts`) спредит `...patch` без `??`-защиты строк/массивов (`servicesList`/`businessName`/`pricingPolicy`/`hours`/`addressPolicy`), поэтому пустые значения затирали базу. (2) В `/agent/chat` условие `if (turn.carcass && !agent.carcass)` сохраняло первый ненулевой каркас и больше не обновляло, хотя билдер «болтает» каркас между ходами. (3) В `packages/wa-pipeline/src/handler.ts` `handoffRank` имел `hot_lead=3` и `complaint=3`, а эскалация требует строго `newRank > prevRank`.
- **Как решили:** (1) Patch строится с семантикой «пустое = не трогаем»: пустые строки/списки не пишутся, `addressPolicy=""` сбрасывается только при непустых филиалах. (2) Запрос `existingPrompt` поднят выше carcass-блока; условие стало `if (turn.carcass && (!agent.carcass || !existingPrompt))` — каркас перезаписывается, пока промпта нет (на create-ходе промпт ещё не сохранён, поэтому осядет финальный каркас), после появления промпта фиксируется. (3) `complaint=4` в `handoffRank`. Обратная сторона: hot_lead после complaint не эскалирует — но раньше при 3=3 он тоже молчал.
- **Как проверить / не повторить:** (1) В кабинете при заполненном профиле очистить «Услуги» и сохранить → `businessProfile.data.servicesList` в БД цел; пустые филиалы не затирают `hours`/`addressPolicy`. (2) Онбординг выездной ниши → после create `agent.carcass` = каркас последнего хода билдера. (3) После hot_lead прислать жалобу → владельцу падает повторное уведомление. Деплоить ОБА сервиса `api` и `jobs` (complaint-логика в wa-pipeline потребляется из jobs — прод-путь WA, и из api — legacy inbound).

## 2026-06-11 — Красный typecheck @jazu/db (резолв модулей)

- **Что случилось:** полный `pnpm typecheck` из корня падал, красным был только `@jazu/db`. Ошибки — каскад «нет экспортов» из `../shared/src` и `../ai/src` (`TS2305`/`TS2459`) и `TS2835` (нужны явные расширения `.js`); в коде самого `db` (`index.ts`, `prisma/seed.ts`) ошибок не было. Маскировало возможные будущие реальные ошибки типов.
- **Почему:** пре-существующая регрессия с коммита `6878263` (3 июня, `fix(shared): импорт botContract для сборки Next/Turbopack`) — там из `packages/shared/src/index.ts` убрали `.js` ради сборки web на Next/Turbopack, что сломало `nodenext`-тайпчек у потребителей `shared`. Компенсирующий override `moduleResolution: "Bundler"` завезли в `packages/shared/tsconfig.json` и `packages/ai/tsconfig.json`, а `packages/db/tsconfig.json` пропустили — он остался с пустым `compilerOptions` и резолвил по базовому `nodenext` (`tsconfig.base.json`). Пуши `e9487d5`/`ff7a962` (только `packages/ai`) к регрессии отношения не имели.
- **Как решили:** добавили в `packages/db/tsconfig.json` тот же override, что у `shared`/`ai` — `module: "ESNext"` + `moduleResolution: "Bundler"`. Меняет только как тайпчекается `db`; импорты `shared`, сборку web и Prisma не задевает.
- **Как проверить / не повторить:** `pnpm typecheck` из корня — все 10 пакетов зелёные. При добавлении нового пакета, который тайпчекает `@jazu/shared`, не забывать про этот override (системный фикс — поднять `moduleResolution: "Bundler"` в `tsconfig.base.json` — отдельная задача, сперва проверить пакеты, которым нужен чистый `nodenext`).

## 2026-06-11 — test-chat дубль/заморозка, повторный handoff, пустой пузырь

- **Что случилось:** (1) В тестовом чате (вкладка «Тест») бот «удваивал» реакцию на последнюю реплику и не учитывал свежий контекст в длинных диалогах — то же при регенерации после коррекции. (2) Если по диалогу уже был открыт лид (`status="new"`), а клиент позже «дозревал» (например, нестандартный вопрос → «хочу оплатить»), владелец повторного сигнала НЕ получал. (3) Когда бот молчит на спам/офф-топик, в ленту WhatsApp-диалога писался пустой out-пузырь.
- **Почему:** (1) В `apps/api/src/routes.ts` роуты `/test-chat/chat` и реген в `/test-chat/correct` грузили историю `orderBy: asc, take: 16` (ПЕРВЫЕ 16 → заморозка) и не отсекали текущее/воспроизводимое сообщение, которое и так передаётся отдельным аргументом `message` в `buildRuntimeTurn` (→ дубль). Тот же класс бага, что чинили в `handler.ts` для WA. (2) `writeLeadIfNeeded` в `packages/wa-pipeline/src/handler.ts` при найденном открытом лиде делал ранний `return existing.id` без уведомления. (3) `waMessage.create` (direction "out") сохранялся безусловно, даже при пустом `runtimeTurn.reply`; пустой пузырь засорял ленту и накручивал счётчик `outboundLastHour`/`isFirstBotReply`.
- **Как решили:** (1) Оба роута: `orderBy: desc, take: 16` + `history.reverse()` + `.slice(0, -1)` в `buildRuntimeTurn`. (2) Блок отправки уведомлений (WhatsApp владельцу + Telegram) вынесен в хелпер `sendHandoffNotification` (грузит agent по id); добавлен `handoffRank` (out_of_scope=1, requested=2, hot_lead=3, complaint=3); при повторном handoff с более срочным типом — обновляем `fields` лида (`handoffType`, `escalatedAt`) и шлём уведомление повторно, иначе молчим (без спама). (3) `waMessage.create` для out обёрнут в guard `runtimeTurn.reply.trim().length > 0`.
- **Как проверить / не повторить:** в тесте на диалоге 2-3 пар реген не должен удваивать реакцию на последнюю реплику; длинный диалог учитывает свежие сообщения. Эскалация: после `out_of_scope` приходит «хочу оплатить» (`hot_lead`) → владельцу падает повторное уведомление; на равный/менее срочный тип — тишина. Спам/офф-топик не создаёт пустых пузырей в ленте. При появлении новых мест загрузки истории под `buildRuntimeTurn` использовать паттерн desc+reverse+slice.

## 2026-06-11 — Гейты готовности и история диалога под новую 4-шаговую воронку

- **Что случилось:** (1) После перехода на новую воронку билдера владелец проходил весь конструктор, `readyToTest=true`, но persisted-флаг `readyToFinalize` оставался `false` — промпт «не финализировался». (2) В длинных WhatsApp-диалогах бот терял свежий контекст.
- **Почему:** (1) Два бэкенд-гейта в `apps/api/src/routes.ts` остались под старую воронку: `isProfileReadyForPrompt` требовал `businessName` + `offerings`/`description` + `profileScore >= 6`, а create-гейт (`forcingCreate`/`baseFilled`) проверял `hours`. Новая воронка собирает `niche/servicesList/geography/leadGoal` и НЕ спрашивает `businessName`/`hours` (приходят позже через форму «Данные о бизнесе»). (2) В `packages/wa-pipeline/src/handler.ts` история грузилась `orderBy: asc, take: 20` — это ПЕРВЫЕ 20 сообщений диалога, а не последние.
- **Как решили:** (1) `isProfileReadyForPrompt` переписан на `niche+servicesList+geography+leadGoal`; в create-гейте `hours` заменён на `leadGoal`; неиспользуемая `profileScore` удалена (коммит `c214fc3`). (2) История грузится `orderBy: desc, take: 20` + `history.reverse()` — последние 20 в хронологическом порядке; `.slice(0, -1)` ниже не трогали (коммит `bcfe9f6`).
- **Как проверить / не повторить:** новый владелец проходит билдер (ниша+услуги+гео+цель) → `readyToFinalize` становится `true`, промпт сохраняется. В длинном WA-диалоге бот помнит последние сообщения. При изменении полей воронки синхронизировать оба гейта в `routes.ts`.

## 2026-06-10 — Мигание гостевой шапки при F5 на /dashboard

- **Что случилось:** залогиненный пользователь обновлял страницу `/dashboard` и на ~1 секунду видел гостевую шапку `GuestHeader` с кнопкой «Подключить WhatsApp», затем каркас сменялся на кабинетный `SideNav`. С других кабинетных страниц это уже убирали.
- **Почему:** в `apps/web/lib/route-access.ts` функция `isPublicGuestPath` числила `/dashboard` публичным путём воронки, поэтому `AppShell` во время загрузки `/auth/me` показывал гостевую шапку вместо нейтрального каркаса.
- **Как решили:** убрали `/dashboard` из `isPublicGuestPath` (коммит `bdf1a4b`) — при F5 до ответа `/auth/me` показывается нейтральный каркас без шапки; гость на `/dashboard` получает шапку после короткой паузы.
- **Как проверить / не повторить:** F5 на `/dashboard` под логином — гостевой шапки быть не должно. При добавлении новых кабинетных страниц не включать их в `isPublicGuestPath`, если ими пользуются залогиненные.

## 2026-06-02 — Обзорный тур по кабинету не показывался / переработан

- **Что случилось:** после нового онбординга обзорный тур («сводка по сайту») не показывался новому юзеру в кабинете. Плюс сам тур был «не тот»: floating-карточка, которую можно закрыть крестиком, без привязки к элементам и без авто-открытия вкладок/окон.
- **Почему:** `OnboardingTour` не был привязан к завершению онбординга — он мог стартовать ещё на `/whatsapp` (пока `needsPhone === true`) и сразу сохранял прогресс на сервер (`PATCH /settings onboardingState`), из-за чего к моменту попадания в кабинет шаг уже оказывался пройденным/«done». Источник правды — серверный `onboardingState.step`.
- **Как решили:**
  - `apps/web/components/onboarding-tour.tsx`: тур стартует ТОЛЬКО когда `useAuthStatus()` даёт `ok === true && needsPhone === false` (онбординг полностью завершён). Переписан в нескипаемый (убран крестик, единственное действие — «Далее»), с привязкой карточки к элементам по `data-tour` (стрелка-указатель) и авто-действиями по шагам: старт у кнопки «Добавить данные о бизнесе» → открытие окна доп-данных → вкладка «Тест» → переходы по `/chats`, `/whatsapp`, `/settings`, `/billing`. Карточкам задан `pointer-events-auto` и `z-[60]`, чтобы кнопка «Далее» работала поверх модалки (Radix вешает `pointer-events:none` на body).
  - `apps/web/components/chat-workspace.tsx`: кнопке доп-данных добавлен `data-tour="extra-data-btn"`; добавлены слушатели событий тура `jazu:switchToSetup`, `jazu:openExtraData`, `jazu:closeExtraData` (плюс существующий `jazu:switchToTest`).
- **Как проверить / не повторить:** новый аккаунт после подключения WhatsApp и подтверждения личного номера попадает в кабинет → тур стартует от кнопки «Добавить данные о бизнесе», «Далее» сам открывает окно/переключает вкладку/переходит на страницу, крестика нет. Существующие аккаунты с `onboardingState.step === "done"` тур не видят (это норма). Тур не должен стартовать, пока `needsPhone === true`.

## 2026-06-02 — Онбординг: пропал промежуточный экран WhatsApp и порядок «подключение → номер»

- **Что случилось:** (1) Кнопка «Подключить WhatsApp» в гостевой шапке кидала сразу на `/auth`, минуя промежуточный экран «последний шаг» (он остался только у триггера из теста). (2) После первого входа (Google/email) у юзера сразу спрашивали личный номер на `/auth/phone` — задуманный порядок «сначала подключить WhatsApp, потом подтвердить номер для уведомлений» не работал.
- **Почему:** (1) `handleConnectClick` в `guest-header.tsx` делал `router.push("/auth?next=/whatsapp")` вместо `/whatsapp`. (2) Google callback и email-флоу вели нового юзера на `/auth/phone`, а `PhoneRequiredGuard` пускал только на `/auth/phone` — до экрана подключения было не добраться; на `/auth/phone` при несовпадающем номере без подключённого бота `verify-start` отдавал 409 «Сначала подключите WhatsApp» (тупик).
- **Как решили:**
  - `apps/web/components/guest-header.tsx`: CTA ведёт на `/whatsapp` (промежуточный экран), убран лишний `persistNext`.
  - `apps/web/components/whatsapp-wizard.tsx`: воронко-текст гостевого блока «последний шаг»; на экране «WhatsApp подключён» для нового юзера (`me.needsPhone`) добавлен шаг подтверждения номера уведомлений (ask → input → code) поверх готовых `/auth/phone/verify-start` и `/auth/phone/verify-confirm`.
  - `apps/api/src/routes.ts`: Google callback и magic-link callback ведут нового юзера на `/whatsapp` вместо `/auth/phone`.
  - `apps/web/components/auth-client.tsx`: email-логин при `needsPhone` редиректит на `/whatsapp`.
  - `apps/web/components/phone-required-guard.tsx`: цель редиректа `/whatsapp`, whitelist `{ /whatsapp, /auth/phone }`; гейт остаётся жёстким.
- **Как проверить / не повторить:** Гость с настроенным ботом жмёт «Подключить WhatsApp» → промежуточный экран, а не сразу `/auth`. Новый юзер после входа попадает на `/whatsapp`; пока бот не подключён — в кабинет не пускает. После подключения: «Да, этот номер» → сразу кабинет; «Нет» → ввод номера → код с номера бота → кабинет. Возвращающийся юзер (с номером) видит обычный экран «Что дальше».

## 2026-06-02 — Три дефекта умности бота (leadGoal, конкретика, коучмарк)

- **Что случилось:** (1) Билдер повторно спрашивал `leadGoal` у владельца, который уже выразил цель при выборе модели («сам записывать на замер»). (2) Рантайм принимал расплывчатое время («к вечеру») как конкретный слот и не уточнял. (3) Коучмарк «Подключить WhatsApp» не всплывал после захвата лида в гостевом режиме.
- **Почему:** (1) ШАГ 5 в билдере явно запрещал выводить `leadGoal` из модели → поле оставалось пустым → попадало в «Что ещё не закрыто» → повторный вопрос. `botModel`/`carcass` не входили в блок ПАМЯТЬ (knownLines), LLM не видела их как уже известные. (2) Правил отклонения расплывчатых ответов по ключевым параметрам в `## КАК ВЕСТИ КВАЛИФИКАЦИЮ` не существовало. (3) `Trigger 1` в `maybeFireChatTriggers` был жёстко привязан к `handoffType === "hot_lead"`, а бот не всегда выставлял это значение при самостоятельном сборе заявки.
- **Как решили:** Коммит `ee52efa`.
  - `packages/ai/src/prompts.ts`: ШАГ 5 переписан — разрешает фиксировать `leadGoal` из ответа о модели без переспроса; добавлен запрет на повтор известного в «Чего НИКОГДА». Правило 6 в `## КАК ВЕСТИ КВАЛИФИКАЦИЮ` — отклонять расплывчатые ключевые ответы и уточнять до конкретики. `buildCarcassBlock` booking/inspection — слот и время визита = конкретный диапазон. Секция `## ПЕРЕДАЧА МЕНЕДЖЕРУ` — захваченная заявка выставляет `shouldHandoff=true, handoffType="hot_lead"`.
  - `packages/ai/src/index.ts`: `buildBuilderTurn` — `botModel` и `carcass` добавлены в `knownLines`.
  - `apps/web/components/chat-workspace.tsx`: `maybeFireChatTriggers` Trigger 1 срабатывает на любой позитивный хендофф (`shouldHandoff && handoffType !== "complaint" && !== "out_of_scope"`).
- **Как проверить / не повторить:** Билдер «пластиковые окна» + «сам записывать на замер» → `leadGoal` фиксируется сам, отдельного вопроса нет. Тест: «можно к вечеру» → бот уточняет «17:00 или 19:00?». Тест (гость): бот подтвердил заявку → коучмарк появляется.

---

## 2026-05-29 — Бот отвечал на старые диалоги (до подключения)

- **Что случилось:** на новые диалоги бот отвечал правильно, но если клиент
  писал в СТАРЫЙ диалог (переписка велась до привязки бота) — бот всё равно
  отвечал, хотя не должен.
- **Почему:** фильтр `botRespondsSince` ловил старый диалог только если (1)
  `messageTimestamp` сообщения старый, или (2) Conversation уже есть в нашей БД.
  Но старый чат из WhatsApp, которого нет в нашей БД, + свежее сообщение от
  клиента → оба условия мимо → бот отвечал. Мы знали только чаты, прошедшие
  через бота, а какие существовали в WhatsApp до подключения — нет.
- **Как решили:** снимок «до-коннектных» чатов из WhatsApp history-sync.
  • `syncFullHistory: true` в makeWASocket — полная история при привязке;
  • worker слушает `messaging-history.set`, собирает chatId из chats+messages,
  шлёт в API ([apps/wa-worker/src/manager.ts](../apps/wa-worker/src/manager.ts));
  • API `POST /internal/wa-preconnection-chats` сохраняет их в новую таблицу
  `WaPreConnectionChat`, но только в «окне свежей привязки» (botRespondsSince
  < 15 мин) — чтобы reconnect старой сессии не пометил чаты, которые бот уже
  ведёт ([apps/api/src/routes.ts](../apps/api/src/routes.ts));
  • handler: если chatId в WaPreConnectionChat → `pre_connection_message`
  ([packages/wa-pipeline/src/handler.ts](../packages/wa-pipeline/src/handler.ts));
  • очистка снимка при «Отключить».
- **Как проверить / не повторить:** 100% недостижимо — WhatsApp сам не отдаёт
  полную историю за всё время; очень старый неактивный чат вне history-sync
  теоретически проскочит. `syncFullHistory` максимизирует полноту снимка.
  Миграция `20260529000000_wa_preconnection_chat`.

## 2026-05-29 — Анти-абуз WA-номера срабатывал задним числом

- **Что случилось:** при привязке чужого (уже застолблённого) номера с другого
  аккаунта код всё равно выдавался, уведомление приходило, на телефоне привязка
  проходила; отказ срабатывал постфактум, а на фронте ошибка не показывалась.
- **Почему:** claim проверялся только в `connection.update → open` (post-check),
  т.е. уже ПОСЛЕ того как WhatsApp привязал устройство. Фронт в этот момент
  показывал экран с кодом и не отображал status=error.
- **Как решили:** добавили PRE-CHECK в `POST /whatsapp/pair`
  ([apps/api/src/routes.ts](../apps/api/src/routes.ts)): для pairing-code flow
  номер известен заранее (юзер сам вводит), поэтому проверяем `WaPhoneClaim` по
  `phoneHash` ДО выдачи кода. Чужой номер → 409 → фронт показывает `data.error`,
  код не выдаётся. Post-check в worker оставили как защиту от подмены номера и
  для QR-flow. Коммит `747759f`.
- **Как проверить / не повторить:** с чужого аккаунта тот же номер → сразу
  красная ошибка, кода нет. Для QR-flow pre-check невозможен (номер заранее
  неизвестен) — там остаётся post-check с разрывом сессии.

## 2026-05-29 — WA authState не сохранялся (Request body too large)

- **Что случилось:** после успешной привязки шёл бесконечный
  `failed to commit mutations, rolling back` + `failed to decrypt message`;
  сессия не стабилизировалась, при рестарте worker привязка терялась.
- **Почему:** Baileys после history-sync сохраняет раздутый authState (сотни
  prekeys + app-state + signal sessions) через `PUT /internal/wa-auth`, а
  глобальный `bodyLimit` API (256 KB) отбивал его с 500 «Request body is too
  large».
- **Как решили:** точечно подняли `bodyLimit` до 32 MB только на роуте
  `PUT /internal/wa-auth` ([apps/api/src/routes.ts](../apps/api/src/routes.ts)).
  Глобальный лимит не трогали (он защищает публичные роуты; роут internal +
  под x-internal-token). Коммит `5b2c2c3`.
- **Как проверить / не повторить:** после привязки в логах нет шторма
  mutations; `SELECT LENGTH(authState::text) FROM "WaConnection"` у connected —
  сотни КБ. Если authState вырастет за 32 MB — поднять лимит или перейти на
  key-value хранилище ключей.

## 2026-05-29 — WA: после кода/QR «не удалось» (515 reconnect)

- **Что случилось:** код вводится/QR сканируется, телефон думает и пишет
  «Couldn't link device»; в логах `pairing configured successfully` → 515 →
  тишина, привязка не завершалась.
- **Почему:** на code 515 (restartRequired) мы звали `this.start(agentId)` без
  опций, но guard в `start()` видел `managed.status='pairing'` (не disconnected)
  и возвращал осиротевшее соединение, НЕ пересоздавая сокет. Reconnect не
  происходил → WhatsApp по таймауту инвалидировал линк.
- **Как решили:** опция `restart: true` в `start()`
  ([apps/wa-worker/src/manager.ts](../apps/wa-worker/src/manager.ts)) — обходит
  guard, пересоздаёт сокет, НЕ стирая creds (нужны свежие с registered=true);
  плюс снятие listeners со старого сокета. Обработчик 515 зовёт
  `start(agentId, { restart: true })`. Коммит `d98fb9d`.
- **Как проверить / не повторить:** после 515 в логах сразу идёт новый
  `connected to WA` → `logging in (passive:true)` → `opened connection to WA`.

## 2026-05-29 — WA-привязка не работала у всех (browser-tuple)

- **Что случилось:** и QR, и pairing-код не доводили до привязки у всех юзеров;
  в логах `connected to WA` → `attempting registration` → тишина → `QR refs
attempts ended` → reconnect по кругу. Ни 515, ни pair-success.
- **Почему:** кастомный browser-tuple `["app.jazu.chat","Chrome","Ubuntu"]`
  (ставили ради красивого имени устройства в Linked Devices). Нестандартный
  формат ломает доставку pairing — подтверждено Baileys issue #2306.
- **Как решили:** вернули стандартный `Browsers.ubuntu("Chrome")`
  ([apps/wa-worker/src/manager.ts](../apps/wa-worker/src/manager.ts)). Имя
  устройства снова «Chrome (Ubuntu)» — рабочая привязка важнее кастомного имени.
  Коммит `6bb1b72`.
- **Как проверить / не повторить:** НЕ ставить произвольную строку в browser-
  tuple для pairing — только стандартные `Browsers.*`. Кастомное имя устройства
  в Linked Devices и рабочий pairing несовместимы в Baileys 7.0.0-rc13.

## 2026-05-28 — WA «Показать QR» висел / «Отключить» не срабатывал

- **Что случилось:** (1) «Показать QR» после попытки кода ничего не делал;
  (2) «Отключить» крутил спиннер, статус оставался «Подключено»; в логах API
  спам `Worker stop failed: 500 Body cannot be empty when content-type is set
to application/json`.
- **Почему:** (1) `manager.start()` видел existing pairing-сессию и не
  пересоздавал сокет; (2) `buildHeaders()` в worker-client всегда слал
  `Content-Type: application/json`, а Fastify 5 на DELETE/GET без body отбивает
  `FST_ERR_CTP_EMPTY_JSON_BODY`; плюс `/whatsapp/status` слепо доверял worker.
- **Как решили:** `/whatsapp/qr` рвёт висящую pairing-сессию перед start;
  `workerFetch` ставит Content-Type только при наличии body + таймаут 5s;
  `/whatsapp/status` делает БД авторитетной для disconnected; `DELETE /whatsapp`
  best-effort (чистит локально даже если worker недоступен). Коммиты `a658d14`,
  `05740e6`, `28db95b`, `2295ac0`.
- **Как проверить / не повторить:** внутренние вызовы к worker — без
  Content-Type, если нет тела. БД — источник правды для «отключено».

## 2026-05-28 — WA повторный pairing давал «неверный код»

- **Что случилось:** юзер запросил код, не успел ввести, запросил второй — оба
  кода «неверные», UI висел «ожидаем подключения с номера…».
- **Почему:** при повторном `pair()` гасили сокет, но НЕ чистили authState в БД.
  Baileys поднимал partial creds (me/noiseKey без registered) → passive=true
  login → WhatsApp молча отбивал, оба кода отлетали.
- **Как решили:** в `manager.pair()` всегда `wipeAuthStateInDb()` перед
  `start({ fresh: true })` ([apps/wa-worker/src/manager.ts](../apps/wa-worker/src/manager.ts));
  фронт `requestPairCode` сам делает reset при висящей сессии. Коммит `5d43e50`.
- **Как проверить / не повторить:** повторный запрос кода должен генерить
  рабочий код; «Сбросить и заново» полностью чистит authState.

## 2026-05-28 — Google OAuth redirect_uri_mismatch на проде

- **Что случилось:** Google-логин на проде падал с `redirect_uri_mismatch`.
- **Почему:** в Google Cloud Console `Authorized redirect URI` не совпадал с
  тем, что использует бэкенд (`https://api.jazu.chat/api/auth/google/callback`).
- **Как решили:** поправили redirect URI в Google Cloud Console (внешняя
  настройка, не код).
- **Как проверить / не повторить:** при смене доменов синхронизировать
  `GOOGLE_REDIRECT_URI` в .env и Authorized redirect URIs в Google Console.

## 2026-05-28 — PHONE_HASH_PEPPER не пробрасывался в контейнер

- **Что случилось:** после добавления анти-абуза API падал в крэшлуп:
  `PHONE_HASH_PEPPER must be overridden in production`.
- **Почему:** docker-compose.prod.yml перечисляет env явно; новую переменную
  забыли добавить в блок `environment` сервиса api — `.env` сам по себе в
  контейнер не пробрасывается.
- **Как решили:** добавили `PHONE_HASH_PEPPER` в `environment` api
  ([docker-compose.prod.yml](../docker-compose.prod.yml)). Коммит `5f9553d`.
- **Как проверить / не повторить:** при добавлении нового env-секрета —
  обязательно прописать его в `environment` нужного сервиса в compose, не только
  в `.env`.
