# Журнал багов

Хронология решённых багов: что случилось, почему, как решили. Новые записи —
сверху. Правила ведения см. в `.cursor/rules/bugfix-journal.mdc`.

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
