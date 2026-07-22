# PRD: аккуратная интеграция upstream-возможностей 1–8 в Iva

**Статус:** In implementation — Stages 0–6 complete and deployed; Stage 7 explicitly deferred; Stage 8 PR L merged, `0.3.0-rc.6` promotion active
**Дата:** 2026-07-22
**Локальный baseline:** `45a1fd7` (PR #36 merged); candidate version `0.3.0-rc.6`
**Upstream baseline:** `2def9d1` (`0.2.5`)
**Область:** runtime dependencies, управление text/vision-моделями, bash safety, memory safety,
update UX/safety, уведомления об обновлениях, update channels и rich reports

## 1. Резюме

Iva должна получить полезные возможности из свежего `upstream/main`, не заменяя ими локальную
архитектуру `0.3.0-rc.5`. Upstream и локальная ветка разошлись после `e09ec88`: upstream содержит 35
уникальных коммитов, локальная ветка — 72. Прямой merge или последовательный cherry-pick не является
допустимым способом реализации этого PRD.

Интеграция выполняется как перенос продуктовых идей поверх локальных источников истины:

- PostgreSQL Workflow profile, recovery, doctor, observability, backup/restore и release gates
  сохраняются;
- обновление остаётся staged-транзакцией с проверкой до активации;
- production не используется как automated test environment;
- text и vision считаются отдельными ролями модели и управляются независимо;
- Telegram-кнопки никогда не становятся каналом ввода новых API-ключей;
- любое новое поведение включается только после contract tests и применимых disposable replicas.

## 2. Цель

Дать владельцу Iva более удобное управление моделями и обновлениями, повысить безопасность host-tools
и долговременной памяти, а также подготовить переход на актуальный Eve/AI SDK без регрессий уже
стабилизированного runtime.

Пользовательский результат:

1. `/model` показывает текущие text и vision конфигурации и позволяет менять их кнопками независимо.
2. `/think` быстро меняет reasoning effort только для текстовой модели, когда провайдер это умеет.
3. Ошибочный `cwd` не приводит к непонятной диагностике bash-инструмента.
4. Моментальные эмоции не превращаются в постоянные identity-факты.
5. `/update` показывает весь прогресс в одном сообщении, сохраняя текущие transactional guarantees.
6. Iva один раз уведомляет о новой версии, но никогда не ставит её автоматически.
7. Канал обновлений хранится явно и не может незаметно переключиться на чужую ветку или upstream.
8. Сложные отчёты используют существующий rich-message transport, короткие ответы остаются обычными.

## 3. Scope: восемь интегрируемых возможностей

В этот PRD входят ровно следующие блоки из предыдущего аудита:

1. Eve `0.24.4` и стабильная линия AI SDK.
2. `/model`, `/think`, модельный каталог и `THINKING_EFFORT`.
3. Нормализация и предварительная проверка `cwd` в host bash.
4. Memory guard против записи эмоционального venting как identity-фактов.
5. Сохранение пользовательских изменений, rollback и единый Telegram update-status.
6. Ежедневная проверка новых версий с дедуплицированным уведомлением.
7. Persistent update channel и безопасная миграция legacy-канала.
8. Rich-message правило для отчётов.

Autograph vendor sync, новые модели OpenCode/Kimi и прочие upstream-изменения за пределами этих восьми
блоков не входят. Они могут получить отдельные RFC после завершения этого цикла.

## 4. Неизменяемые продуктовые инварианты

Интеграция считается неуспешной, если нарушен хотя бы один инвариант:

- Telegram allowlist продолжает блокировать control callbacks от посторонних пользователей.
- Polling bridge не перезапускается без необходимости и остаётся доступен во время рестарта агента.
- Смена конфигурации не сбрасывает и не удаляет Workflow sessions.
- Local и PostgreSQL profiles используют один и тот же config contract.
- Vision failure остаётся graceful: текстовый ход продолжается без изображения.
- Текущая Ollama-связка `OLLAMA_MODEL` + `OLLAMA_VISION_MODEL` работает без миграции `.env`.
- Codex сохраняет `store:false`, OAuth refresh и удаление server-side item references.
- Reasoning не попадает обратно в replayable conversation history.
- `.env` и auth state не выводятся в логи, Telegram или support artifacts; mode остаётся `0600`.
- Update сначала строится и проверяется в staging, затем активируется; readiness failure возвращает
  предыдущую рабочую сборку.
- Update не выполняет автоматические destructive Git/DB/vault действия.
- Production vault остаётся отдельным репозиторием и не меняется при обновлении vault template.
- Все существующие capability manifest entries и behavioral canaries сохраняются.

## 5. Целевой UX управления моделями

### 5.1. Модельные роли

Конфигурация разделяется на три независимые пользовательские сущности:

| Роль | Назначение | Меняется через |
|---|---|---|
| Text | Основные диалоги, tools, planning и память | `/model` → «Текст» |
| Vision | Описание изображений и OCR | `/model` → «Зрение» |
| Effort | Глубина reasoning текстовой модели | `/model` → «Глубина» или `/think` |

Изменение одной роли не должно молча менять другую. В частности:

- смена text-модели не меняет vision-модель;
- смена vision-модели не меняет text-модель и context window;
- `/think` не влияет на vision;
- переход text на другого провайдера не переносит vision автоматически на этого провайдера;
- если vision-конфигурация не задана отдельно, сохраняется legacy-поведение «vision через text
  provider».

### 5.2. Обратимо-совместимый env contract

`MODEL_PROVIDER` сохраняется и остаётся провайдером текстовой модели. Переименование в
`TEXT_PROVIDER` не выполняется, чтобы не ломать существующие `.env`, setup, docs и installed units.

Добавляются:

```dotenv
# Optional. Unset means: use MODEL_PROVIDER, preserving the current behavior.
VISION_PROVIDER=

# Text reasoning; applied only when the active text provider supports it.
THINKING_EFFORT=

# Existing and new provider-specific vision model slots.
OLLAMA_VISION_MODEL=minimax-m3
OPENCODE_VISION_MODEL=
OPENROUTER_VISION_MODEL=
CODEX_VISION_MODEL=
```

Правила разрешения:

1. `textProvider = MODEL_PROVIDER || "ollama"`.
2. `visionProvider = VISION_PROVIDER || textProvider`.
3. Text model берётся из существующего provider-specific `*_MODEL`.
4. Vision model берётся из `*_VISION_MODEL`; при отсутствии используется текущий безопасный default
   этого provider.
5. Если `VISION_PROVIDER` указывает на provider без настроенной авторизации, конфигурация считается
   неготовой и не активируется.
6. Старый `.env` без новых ключей разрешается в ту же конфигурацию, что и до изменения.

Cross-provider vision поддерживается, потому что у владельца text и vision могут отличаться не
только model id, но и провайдером. Новые credentials через Telegram не принимаются: picker показывает
только уже настроенные и доступные provider profiles.

### 5.3. `/model`: корневой экран

Сообщение редактируется на месте:

```text
Модели Iva

Текст:   Ollama Cloud · deepseek-v4-pro
Зрение:  Ollama Cloud · minimax-m3
Глубина: medium

[💬 Текст] [👁 Зрение]
[🧠 Глубина] [🔄 Обновить список]
[Закрыть]
```

Точные названия приходят из sanitized model catalog; ключи, URL с credentials и auth state не
показываются.

### 5.4. Выбор text-модели

Поток:

```text
/model
  → Текст
  → provider из списка уже настроенных
  → live/fallback список tool-capable моделей
  → модель
  → экран diff
  → «Проверить и применить» / «Назад» / «Отмена»
```

Экран diff обязан показать, что vision не меняется:

```text
Текст:  old-provider/model → new-provider/model
Зрение: без изменений · vision-provider/vision-model
Глубина: medium → medium
```

Перед записью конфигурации выполняется bounded capability probe: модель должна дать текстовый ответ и
поддержать tool/function calling. Probe выполняется только после явного нажатия владельца. Неуспех не
меняет `.env` и не перезапускает сервис.

### 5.5. Выбор vision-модели

Поток:

```text
/model
  → Зрение
  → provider из списка уже настроенных
  → live/fallback список multimodal-кандидатов
  → модель
  → экран diff
  → «Проверить и применить» / «Назад» / «Отмена»
```

Vision probe использует встроенное одноразовое синтетическое изображение без пользовательских данных
и ожидает конкретный OCR/semantic marker. Text model и `THINKING_EFFORT` в этом probe не участвуют.

Если provider не даёт достоверный capability inventory, модель можно выбрать только из локальной
curated allowlist. Произвольный model id остаётся доступен через `iva config`, где есть явный live
test, но не через Telegram-кнопки.

### 5.6. `/think`

Экран показывает текущий effort и только поддерживаемые активным text provider значения:

```text
Глубина рассуждения: medium

[Минимальная] [Низкая]
[Средняя ✓] [Высокая]
[Назад]
```

Первый поддерживаемый runtime — Codex Responses API. Для остальных provider значение не должно
создавать иллюзию эффекта: UI показывает «не поддерживается этой текстовой моделью» и не записывает
параметр. Возможность расширяется только после provider-specific contract test.

### 5.7. Атомарное применение и rollback конфигурации

Применение model config выполняется как маленькая транзакция:

1. Проверить allowlist пользователя и актуальность callback state.
2. Взять отдельный config-update lock.
3. Перечитать `.env`, не полагаясь на состояние в памяти polling bridge.
4. Повторно проверить выбранный provider/model.
5. Создать private backup только текущего `.env` в `ASSISTANT_DATA_DIR`.
6. Точечно заменить разрешённые ключи через общий env-file helper.
7. Записать temp-файл, `fsync`/rename, выставить `0600`.
8. Перезапустить только `iva.service`; polling bridge остаётся жив.
9. Дождаться readiness тем же контрактом, который использует updater/doctor.
10. При неуспехе вернуть предыдущий `.env`, повторно запустить прежнюю конфигурацию и сообщить об
    откате.
11. При успехе удалить временный backup и показать фактически активные text/vision/effort.

Состояние wizard имеет короткий TTL и привязано к `user_id`, `chat_id` и случайному opaque id.
Callback data не содержит provider secrets и не доверяет model id, пришедшему из Telegram без
повторной серверной проверки.

## 6. Детальные требования по функциям 1–8

## Функция 1. Eve `0.24.4` и stable AI SDK

### Польза

- уход с beta-линии AI SDK;
- получение актуальных исправлений Eve;
- уменьшение долгосрочного dependency debt.

### Ограничение

Upstream обновляет зависимости в упрощённой ветке без локального PostgreSQL Workflow, staged update,
release canaries и provider/vision hardening. Его lockfile и patch нельзя принимать целиком.

### Реализация

1. Зафиксировать текущие provider, vision, Workflow и recovery canaries на старом runtime.
2. Обновить зависимости в отдельной ветке точными версиями: `eve@0.24.4`, `ai@7.0.29`,
   `@ai-sdk/openai@4.0.15`, `@ai-sdk/openai-compatible@3.0.11` и
   `@workflow/world-local@5.0.0-beta.28`; синхронизировать `overrides.ai` и `resolutions.ai` на
   `7.0.29`. Прямой local-world
   pin нужен owned doctor/health/recovery scripts и совпадает со встроенной в Eve версией.
3. Оставить `@workflow/world-postgres@5.0.0-beta.23`. Переход на beta.27 является отдельной
   Workflow-дельтой и не входит в PR L; stable 4.x несовместим с Workflow 5 beta line Eve.
4. Пересоздать только необходимый `patch-package` patch и закрепить его owned behavioral test:
   детерминированные prompt/tool validation errors завершаются terminal без durable retry-loop.
5. Перенести local Workflow state с legacy `.workflow-data` в официальный путь Eve
   `.eve/.workflow-data` через проверяемое copy-and-activate, не удаляя legacy state в этом релизе.
6. Адаптировать типы/интерфейсы, operational scripts и data manifest, не меняя пользовательское
   поведение `/model`, `/think`, text/vision ролей и update channel.
7. Подтвердить оба storage profiles и все supported providers mock-контрактами.
8. Выполнить bounded live canary отдельно для активного text provider и активного vision provider;
   для Codex проверить минимум два последовательных turn и фактический text effort.

### Acceptance criteria

- capability manifest не имеет необъяснимой дельты;
- второй и последующие Codex turns не получают server-side item reference errors;
- reasoning stripping проходит generate и stream paths;
- local/PostgreSQL restart-resume и task side-effect canaries зелёные;
- legacy local state мигрируется атомарно, повторный update идемпотентен, а rollback запускает старый
  runtime на сохранённом legacy state;
- portable backup содержит `.eve/.workflow-data`, но не выдаёт остальной `.eve` за personal state;
- текущие vision defaults сохранены;
- update/rollback replica проходит на обеих storage-конфигурациях.

### Решение

Высокая ценность, высокий риск. Реализуется последним функциональным этапом, хотя числится пунктом 1.

## Функция 2. `/model`, `/think` и независимые text/vision роли

### Польза

- управление рабочей моделью без SSH;
- быстрое переключение стоимости/скорости/качества;
- явное отображение модели, которая видит изображения;
- защита от случайной замены vision при переключении text.

### Реализация

- создать общий typed model catalog, используемый setup, runtime validation и Telegram wizard;
- вынести разрешение vision provider/model в отдельный чистый resolver;
- сохранить `MODEL_PROVIDER` как text source of truth;
- добавить optional `VISION_PROVIDER` и provider-specific vision model vars;
- добавить безопасный env editor с allowlist ключей и CRLF/quotes/comment preservation;
- реализовать bridge-owned `/model` и `/think`, которые не попадают в Eve workflow;
- добавить atomic apply/readiness/rollback;
- обновить `CODEBASE_MAP.md`, потому что ответственность за vision config станет отдельной от text
  provider config.

### Acceptance criteria

- старый env даёт byte-for-behavior совместимую конфигурацию;
- text change не меняет resolved vision;
- vision change не меняет resolved text/effort;
- `/think` влияет только на Codex text request;
- список provider ограничен уже настроенными credentials/OAuth;
- чужой user/callback, устаревший callback и поддельный model id отклоняются;
- failed probe/readiness оставляет прежний `.env` и рабочий сервис;
- ни один тест/лог не содержит secret values.

## Функция 3. Bash `cwd` safety

### Польза

Модель получает понятную диагностику вместо сырого `ENOENT/EACCES`, видит фактическую директорию
запуска и реже делает ошибочные выводы о filesystem.

### Реализация

- `~` и `~/...` разворачиваются через фактический service-user HOME;
- заданный путь проверяется как доступная директория до `exec`;
- `/workspace` не маппится молча на проект;
- успешный результат включает нормализованный `cwd`;
- schema/инструкции рекомендуют не задавать `cwd`, если путь неизвестен.

### Acceptance criteria

- пустой `cwd`, абсолютный путь, `~`, `~/child`, отсутствующий файл, файл вместо каталога и
  inaccessible directory покрыты тестами;
- command не запускается при invalid `cwd`;
- существующие timeout/truncation/exit-code semantics сохранены;
- host-path или HOME с private data не попадает в публичный manifest/support bundle.

## Функция 4. Memory guard против эмоциональных identity-фактов

### Польза

Временная усталость, раздражение или самокритика не превращаются в постоянную характеристику
пользователя в CORE и entity cards.

### Реализация

- добавить явное правило в daily rollup prompt;
- усилить memory map: ephemeral mood не является durable preference/identity;
- разрешить только датированную строку в daily-summary или редкую archived note;
- не менять существующий CORE size/recovery guard;
- добавить поведенческий canary с контрастными примерами: transient emotion, устойчивое явно
  сформулированное предпочтение и клинический/исторический факт, который пользователь прямо просит
  запомнить.

### Acceptance criteria

- transient venting отсутствует в CORE/contact/project cards;
- событие может остаться в daily-summary без генерализации;
- прямой запрос «запомни» не игнорируется автоматически, но сохраняется в корректном типе и с
  контекстом пользователя;
- существующий rollup, doctor и memory recall canary проходят.

## Функция 5. Update safety и единый Telegram status

### Польза

Владелец видит одну понятную карточку прогресса, а локальные операторские изменения не теряются.

### Локальная архитектурная поправка

Upstream transaction на stash/rebase/reset не заменяет локальный `scripts/update-runtime.mjs`.
Источником истины остаются staging worktree, migration contract, verified Workflow backup,
readiness и rollback activation.

### Целевой статус

Одно Telegram-сообщение последовательно показывает:

```text
◇ Проверяю конфигурацию
◇ Получаю целевую версию
◇ Устанавливаю зависимости
◇ Запускаю тесты и сборку
◇ Проверяю storage profile
◇ Активирую версию
◇ Проверяю readiness
```

Промежуточные completed-фазы не создают новые сообщения. Финал редактирует исходное сообщение.
Если message edit недоступен, допускается одно fallback-сообщение.

### Работа с локальными изменениями

- tracked dirty state по-прежнему блокирует автоматическое обновление по умолчанию;
- автоматический stash не вводится как скрытое поведение;
- отдельный будущий флаг `iva update --preserve-local` может сохранить изменения только после
  доказанного round-trip теста;
- `.env`, workflow env и private data сохраняются текущим transactional updater независимо от Git;
- update lock предотвращает два одновременных обновления из CLI/Telegram/timer.

### Acceptance criteria

- update UI не меняет порядок transaction events;
- Telegram failure не прерывает сам update и не превращает rollback в success;
- broken build, migration failure и readiness failure возвращают предыдущую версию;
- dirty tracked worktree не очищается и не stashing без явного режима;
- весь update status остаётся одним сообщением в нормальном сценарии;
- local и PostgreSQL update replicas проходят.

## Функция 6. Ежедневная проверка новых версий

### Польза

Владелец не пропускает исправления, но сохраняет контроль над production activation.

### Реализация

- отдельный oneshot service и timer;
- только fetch/compare/read-only inspection;
- уведомление один раз на target commit;
- кнопки «Посмотреть»/«Обновить»/«Позже» используют существующий `/update` flow;
- timer schedule использует `ASSISTANT_TIMEZONE` и генерируется тем же unit writer;
- состояние дедупликации хранится приватно в `ASSISTANT_DATA_DIR` и не входит в portable backup как
  пользовательские данные;
- feature включается явно (`IVA_UPDATE_CHECK_ENABLED=true`) либо отдельной CLI-командой; обновление
  никогда не запускается таймером автоматически.

Сравнение выполняется прежде всего по commit ancestry/target commit. Semver отображается пользователю,
но не является единственным условием: локальная версия использует release candidates.

### Acceptance criteria

- повторная проверка одного target не шлёт повторное уведомление;
- новый commit той же версии создаёт новое уведомление;
- недоступная сеть/remote не влияет на agent/polling readiness;
- timer использует заданный timezone и виден в `iva doctor/status`;
- никакая ветка кроме разрешённого update channel не fetch/integrate автоматически.

## Функция 7. Persistent update channel

### Польза

Установка понимает, откуда ей получать проверенные обновления, и не теряет канал после обновления.

### Локальная политика

- production channel по умолчанию: `origin/main`;
- `upstream/main` Шимы никогда не является production update channel;
- upstream остаётся read-only источником ручной интеграции;
- разрешённые каналы принадлежат `origin` и задаются явным sanitized state;
- изменение канала — отдельное owner-действие, а не побочный эффект checkout/merge.

### Реализация

- хранить `{ remote, branch }` в private update state либо разрешённом deployment config;
- при отсутствии state мигрировать legacy install из фактической tracking branch только если remote
  входит в allowlist;
- detached HEAD, неизвестный remote, отсутствующая branch и rewritten history дают понятный blocked
  result;
- release/rc channels проектируются отдельно; в первом релизе допустим только `origin/main`;
- `iva status` показывает канал без URL с credentials.

### Acceptance criteria

- локальная integration branch не становится production channel после временного checkout;
- legacy `main` безопасно закрепляется за `origin/main`;
- `upstream/main` отклоняется;
- rewritten history обрабатывается существующим staged updater, без скрытого hard reset;
- channel state переживает успешный update и rollback.

## Функция 8. Rich reports

### Польза

Таблицы, чек-листы, длинные дайджесты и структурированные отчёты читаются в Telegram лучше обычного
HTML/plain text.

### Локальная архитектурная поправка

`agent/channels/telegram.ts` уже умеет `sendRichMessage` и HTML/plain fallback. Не нужен отдельный
Python sender и не нужен второй transport path.

### Реализация

- уточнить в instructions, какие ответы считаются rich-worthy;
- сохранить автоматический `needsRichMessage` как deterministic final decision;
- короткие ответы, ошибки и подтверждения остаются обычными;
- rich failure всегда деградирует в существующий HTML/plain path;
- outbound security scan выполняется до выбора transport;
- background digest/rollup использует общий formatter/transport contract, где это применимо.

Rich-worthy:

- Markdown-таблицы;
- task lists;
- несколько структурированных секций отчёта;
- `<details>`/формулы и другие конструкции, которые HTML fallback теряет.

Не rich-worthy:

- короткий ответ;
- одно подтверждение действия;
- вопрос пользователю;
- диагностическая ошибка/escape instruction.

### Acceptance criteria

- prompt canary выбирает rich для отчёта и обычный ответ для короткого сообщения;
- transport canary доказывает rich success, rich rejection → HTML и HTML rejection → plain;
- security-redacted текст одинаков для всех fallback paths;
- отправка не дублируется при успешном rich response.

## 7. Последовательность реализации

Нумерация этапов ниже отражает безопасный порядок разработки, а не номера upstream-функций.

## Этап 0. Baseline и дизайн-контракты

**Цель:** зафиксировать текущее поведение до изменений.

### Стартовать отсюда

- `CODEBASE_MAP.md`;
- `agent/provider.ts`, `agent/vision.ts`, `agent/lib/vision-provider.mjs`;
- `scripts/setup.mjs`, `.env.example`, `docs/configuration.md`;
- `scripts/telegram-poll.mjs`, `agent/channels/telegram.ts`;
- `scripts/update-runtime.mjs`, `scripts/lib/update-contract.mjs`;
- `docs/testing.md`.

### Работы

1. Добавить pure resolver tests для текущего text/vision поведения до рефакторинга.
2. Зафиксировать capability snapshot.
3. Записать таблицу supported provider capabilities: text, tools, vision, effort, live inventory.
4. Зафиксировать current update transaction event order.

### Definition of Done

- старые `.env` представлены fixtures без secrets;
- current behavior доказан тестами;
- нет production access и live provider calls.

## Этап 1. Низкорисковые safety improvements

**Функции:** 3 и 4.

### Работы

1. Внедрить bash `cwd` normalization и тест.
2. Внедрить emotional-memory guard и behavioral canary.
3. Обновить capability snapshot только после review diff.

### Gate

- narrow bash/memory tests;
- `npm run verify:pr`.

## Этап 2. Общий model/config contract

**Функция:** фундамент функции 2.

### Работы

1. Создать typed provider capability catalog без Telegram UI.
2. Создать text/vision resolver с legacy fallback.
3. Добавить `VISION_PROVIDER`, provider-specific vision vars и `THINKING_EFFORT`.
4. Перевести setup, runtime и vision canary на общий resolver.
5. Создать atomic env editor и config rollback primitive.
6. Обновить `CODEBASE_MAP.md` и public configuration docs.

### Gate

- resolver/env-file/model-catalog tests;
- reasoning-strip и vision tests;
- `npm run verify:pr`;
- `npm run replica:local`;
- PostgreSQL replica не обязательна, если runtime storage не менялся, но profile-aware build matrix
  обязателен.

## Этап 3. Telegram `/model` и `/think`

**Функция:** завершение функции 2.

### Работы

1. Реализовать callback state/TTL/allowlist.
2. Реализовать раздельные text, vision и effort pickers.
3. Добавить bounded provider probes и atomic apply.
4. Добавить readiness rollback.
5. Обновить `/help`, CLI/docs и command manifest.

### Gate

- Telegram mock tests для всех экранов и callbacks;
- unauthorized/stale/tampered callback tests;
- config apply/rollback fixture;
- `npm run verify:pr`;
- `npm run replica:local` с mock text и vision providers;
- applicable PostgreSQL restart/resume scenario, потому что apply перезапускает runtime.

Live provider probe выполняется только как отдельный release canary с разрешёнными test credentials.

## Этап 4. Rich report policy

**Функция:** 8.

### Работы

1. Уточнить agent instructions без абсолютного запрета plain text.
2. Расширить deterministic rich detection при необходимости.
3. Добавить prompt и transport canaries.

### Gate

- Telegram formatting/delivery tests;
- prompt canary;
- `npm run verify:pr`.

## Этап 5. Update UI и lock

**Функция:** безопасная часть 5.

### Работы

1. Ввести structured progress events вокруг текущего updater.
2. Подключить single-message Telegram reporter.
3. Ввести cross-entrypoint update lock.
4. Сохранить dirty-worktree block по умолчанию.
5. Покрыть Telegram degradation и concurrent update.

### Gate

- update transaction и Telegram UI tests;
- `npm run verify:pr`;
- `npm run replica:install`;
- обе update/rollback storage replicas.

## Этап 6. Update channel и release notifications

**Функции:** 6 и 7.

PR I реализует пункты 1–2 отдельно от notification/timer-поведения PR J, чтобы persistent channel
можно было проверить и выпустить без смешивания с новой фоновой задачей.

### Работы

1. Ввести allowlisted persistent channel state.
2. Мигрировать legacy `main` → `origin/main`.
3. Добавить read-only update check state и deduplication.
4. Добавить opt-in systemd timer и status/doctor coverage.
5. Подключить notification buttons к существующему update flow.

### Gate

- channel migration, rewritten history и remote allowlist tests;
- timer/timezone/idempotent unit install tests;
- notification dedup tests;
- `npm run verify:pr`;
- `npm run replica:install`.

## Этап 7. Явный preserve-local режим

**Функция:** оставшаяся часть 5.

### Product decision

Автоматически сохранять dirty source checkout по умолчанию не требуется. Это advanced operator path.
Решение владельца от 2026-07-21: Stage 7 отложен; PR K не создаётся. Tracked dirty state продолжает
fail-closed блокировать update, без автоматического stash и без изменения текущих файлов.

### Работы

1. Добавить `iva update --preserve-local` только при подтверждённой необходимости.
2. Сохранять точный stash/ref и список untracked paths без `git clean`.
3. Проверять round-trip успешного update, conflict и rollback.
4. Не включать этот режим из ежедневного timer.

### Gate

- disposable Git remote/worktree fixture;
- staged build failure, stash conflict, untracked restore и rollback tests;
- `npm run replica:install` для обоих storage profiles.

Этап может быть отложен без блокировки остальных функций.

## Этап 8. Runtime dependency upgrade

**Функция:** 1.

### Product decisions

1. Целевой runtime фиксируется на `eve@0.24.4`; свежие Eve-релизы не добавляются в этот цикл без
   нового аудита.
2. AI SDK и оба provider package используют exact pins. Lockfile, `overrides.ai` и `resolutions.ai`
   обязаны указывать ту же версию `ai@7.0.29`.
3. `@workflow/world-postgres@5.0.0-beta.23` остаётся без изменений. Его последующее обновление
   выполняется отдельным Workflow PR после soak Stage 8.
   Operational local-world фиксируется отдельно на `@workflow/world-local@5.0.0-beta.28`, совпадающем
   со встроенной версией Eve `0.24.4`; транзитивный beta.25 из PostgreSQL package не используется
   для открытия active local state.
4. Текущий Eve patch сохраняется по существу: `AI_InvalidPromptError`, `AI_InvalidArgumentError`,
   `AI_TypeValidationError`, `AI_NoSuchToolError`, `AI_InvalidToolInputError` и
   `AI_UnsupportedFunctionalityError` классифицируются terminal до общих retry/recoverable правил.
5. `/model` не меняет семантику: text и vision остаются отдельными ролями, `/think` влияет только на
   Codex text request, существующие defaults и credentials не мигрируются.
6. Production не является средой проверки. Merge, RC promotion и production deploy являются
   отдельными решениями.

### Local Workflow state contract

Eve `0.24.4` хранит default local World в `.eve/.workflow-data`, тогда как текущая IVA использует
legacy `.workflow-data`. В PR L вводится один owned resolver для operational-кода со следующими
состояниями:

| Legacy path | Current path | Действие |
|---|---|---|
| отсутствует | отсутствует | fresh local state создаёт Eve |
| есть | отсутствует | offline backup → verified copy во временный sibling → atomic rename |
| есть | есть | current path authoritative; legacy не перезаписывается и остаётся rollback safety net |
| отсутствует | есть | использовать current path без миграции |

Правила миграции:

- source никогда не перемещается и не удаляется в релизе `0.3.0-rc.5`;
- незавершённая копия не может стать active path; повторный запуск безопасен;
- runtime останавливается до snapshot/copy и допускается к сообщениям только после readiness;
- rollback до успешной активации возвращает прежний код и legacy path;
- portable backup/restore включает только `.eve/.workflow-data`, а остальной `.eve` остаётся
  derived/rebuildable;
- transitional restore умеет читать backup с legacy или current layout и восстанавливает layout,
  соответствующий активной версии;
- `WORKFLOW_LOCAL_DATA_DIR` не является пользовательским runtime selector, потому что Eve его не
  читает; test fixtures передают isolated paths через собственные параметры.

### Этапы реализации PR L

1. **Baseline и canaries:** обновить статус PRD, добавить классификационный и runtime no-retry
   canary, а также fixtures четырёх состояний local path.
2. **Dependency transaction:** изменить только `package.json`, lockfile, Eve patch и необходимую
   type/API адаптацию.
3. **State transition:** внедрить owned path resolver и copy-and-activate; обновить updater,
   portable backup/restore, doctor, workflow-health и replica assertions.
4. **Contracts и документация:** обновить data manifest, capability snapshot, configuration/deploy/
   troubleshooting/testing docs. Дельта capability manifest должна быть объяснима только версиями
   runtime и новым official local-state layout.
5. **Automated verification:** узкие tests → `npm run verify:pr` → local/PostgreSQL build matrix →
   install/reinstall/update/rollback/restore replicas.
6. **Review и merge:** PR L проходит review и сливается без production deploy.
7. **RC promotion:** версия `0.3.0-rc.6`, immutable tag на точном merged `main` commit, полный Release
   candidate matrix и sanitized commit-bound report.
8. **Live evidence и soak:** отдельно авторизованные active text/vision canaries и семь непрерывных
   дней на exact-candidate single-owner runtime с тем же commit. Решением владельца от 2026-07-22
   изолированный host не создаётся: после verified off-host backup RC разворачивается как
   контролируемый production canary, а stable promotion остаётся заблокированным до зелёного soak.
9. **Stable production promotion:** только после зелёного soak и отдельного подтверждения владельца.
   Fresh-owner acceptance дополнительно блокирует публикацию stable channel для новых пользователей.

### Статус реализации PR L на 2026-07-22

- Этапы 1–5 реализованы в `codex/runtime-dependency-upgrade`: exact dependency pins, новый Eve patch,
  owned local-state migration, operational path transition, portable backup contract, capability/
  data manifests и документация.
- Локально зелёные narrow contracts, `npm test`, `npm run typecheck`, local и PostgreSQL profile
  builds, `npm run replica:local`, `npm run replica:install` и `npm run verify:pr`; npm audit не
  содержит high-severity advisory.
- PR #34 слит squash-merge в `main` commit `4721034`; PR и post-merge Verify зелёные, включая Node 24,
  оба build profile, clean install/update/rollback и реальную disposable PostgreSQL replica.
- `v0.3.0-rc.5` получил immutable tag, зелёную Release candidate matrix и bounded live provider/
  vision evidence на commit `b6dea1c`, но pre-deploy backup выявил fail-closed дефект на nested
  application-data repository; production остался на `0.3.0-rc.4`.
- PR #36 исправил canonical inventory и derived `.venv` exclusion, прошёл local/install/PostgreSQL
  backup/restore gates и слит в `main` commit `45a1fd7`; post-merge Verify зелёный.
- `0.3.0-rc.6` supersedes RC5. Следующий исполняемый шаг: merge RC6 promotion → annotated tag →
  полный commit-bound Release candidate matrix → повторный live canary → verified production backup
  с off-host копией → контролируемый production canary и семидневный soak.

### Работы

1. Обновить exact-pinned Eve/AI SDK отдельно от feature PRs.
2. Пересобрать patch-package patch и доказать terminal/no-retry semantics.
3. Выполнить безопасную миграцию local Workflow state и transitional backup/rollback.
4. Устранить type/build/runtime несовместимости без изменения model UX.
   Eve `0.24.4` build сохраняет authored-source root, поэтому staged artifact не переносится как
   готовый `.output`: после полного staging proof candidate повторно собирается в active root при
   остановленных writers, а failure возвращает прежние output/modules до restart.
5. Прогнать полный release matrix и bounded live canaries.

### Gate

- `npm run verify:pr`;
- local и PostgreSQL replicas;
- install/update/rollback/restore scenarios;
- migration fixtures для legacy/current local state и повторного update;
- capability manifest diff review;
- live text + vision provider evidence;
- семь дней commit-bound production-like soak;
- release report на immutable commit;
- production deploy не входит в PR и требует отдельного подтверждения.

## 8. Нарезка на PR

Каждый PR должен быть reviewable и не смешивать dependency upgrade с продуктовым поведением.

1. **PR A — baseline model/vision/update contracts.**
2. **PR B — bash cwd safety.**
3. **PR C — emotional memory guard.**
4. **PR D — typed model catalog + dual-role resolver + env editor.**
5. **PR E — `/model` text/vision Telegram wizard.**
6. **PR F — `/think` + Codex effort.**
7. **PR G — rich report policy and canaries.**
8. **PR H — structured update progress + Telegram single-message reporter + lock.**
9. **PR I — persistent `origin/main` channel.**
10. **PR J — opt-in daily update notification.**
11. **PR K — optional preserve-local update mode**, только если Stage 7 подтверждён.
12. **PR L — Eve/AI SDK upgrade.**

## 9. Сквозная тестовая матрица

| Поверхность | Fast contracts | Local replica | PostgreSQL replica | Live canary |
|---|---:|---:|---:|---:|
| Bash cwd | да | нет | нет | нет |
| Memory emotion guard | да | core canary | нет | нет |
| Text resolver | да | да | profile build | release |
| Vision resolver | да | synthetic image | profile build | release |
| `/model` callbacks | Telegram mock | да | restart/resume | release |
| `/think` | provider body mock | да | нет | Codex release |
| Rich reports | transport mock | да | нет | optional Telegram test bot |
| Update UI/lock | да | install/update | update/rollback | нет |
| Update channel | disposable Git | install | storage-neutral | нет |
| Daily notification | mock Git/Telegram | install/timer | storage-neutral | нет |
| Eve/AI SDK | full PR gate | full | full | required |

Ни один automated test не читает локальный `.env`, production vault, production Telegram token или
production PostgreSQL database.

## 10. Observability и диагностика

После внедрения `iva status`/`iva doctor` должны показывать sanitized сведения:

- text provider/model;
- vision provider/model;
- text effort или `unsupported/unset`;
- update channel как `remote/branch`, без credential-bearing URL;
- update-check timer enabled/disabled и время последнего успешного read-only check;
- незавершённый config/update lock только как age/status, без приватного payload.

Ошибки model config классифицируются отдельно:

- provider auth missing/expired;
- model unavailable;
- text tool-calling unsupported;
- vision capability unsupported;
- config write failed;
- restart/readiness failed and rolled back.

## 11. Security requirements

- `/model`, `/think` и update callbacks доступны только allowlisted owner IDs.
- Telegram никогда не запрашивает API key или OAuth token сообщением.
- Model inventory requests используют credentials только в Authorization header и не логируют URL/body
  с секретами.
- `.env` editor меняет только allowlisted keys и не переписывает неизвестные строки.
- Private backup/config state создаётся с `0600`, каталог — `0700`, где применимо.
- Callback payload — opaque id; provider/model читаются из server-side TTL state.
- Rich transport получает уже отредактированный outbound security gate текст.
- Update notification не содержит private remote URL.
- Production live probe выполняется только как отдельное явно авторизованное действие.

## 12. Rollout и rollback

### Rollout

1. Все новые env keys optional.
2. После deploy пользователь продолжает работать на прежней конфигурации.
3. `/model` сначала может быть включён read-only: показать resolved роли без изменения.
4. После прохождения replica/canary включается apply path.
5. Daily update timer остаётся opt-in.
6. Eve/AI SDK upgrade выпускается отдельным `0.3.0-rc.5` release candidate после merge без
   автоматического production deploy.

### Rollback

- удаление `VISION_PROVIDER` возвращает vision к `MODEL_PROVIDER`;
- удаление provider-specific vision override возвращает текущий default;
- удаление `THINKING_EFFORT` возвращает прежнее provider behavior;
- Telegram wizard можно отключить без удаления сохранённой конфигурации;
- update timer можно отключить без изменения update channel;
- dependency upgrade откатывается только через существующий verified updater, без изменения vault и
  user data;
- local rollback использует сохранённый legacy `.workflow-data`; новый `.eve/.workflow-data` не
  удаляется автоматически и остаётся доступен для диагностики/повторной активации.

## 13. Метрики успеха

- 100% model-switch fixtures сохраняют неизменённую невыбранную роль.
- 0 secret values в logs, Telegram payload snapshots и support bundle.
- 100% failed model probes оставляют прежний active config.
- 100% failed readiness после model switch возвращают прежний config и рабочий runtime.
- 100% нормальных update flows используют одно Telegram status-сообщение.
- 0 повторных update notifications для одного target commit.
- 0 автоматических update activations от timer.
- capability manifest не теряет существующие core capabilities.
- полный release matrix зелёный после Eve/AI SDK upgrade.

## 14. Риски и решения

### Риск: смена text provider незаметно сломает vision

**Решение:** отдельный resolved vision profile, явный diff перед apply и invariant test «text change
does not alter vision».

### Риск: каталог предлагает text-only модель для vision

**Решение:** curated multimodal allowlist плюс bounded synthetic-image probe.

### Риск: Telegram callback подменяет model id

**Решение:** opaque callback state, TTL, owner binding и повторная серверная валидация.

### Риск: restart после model switch теряет разговор

**Решение:** restart только `iva.service`, backend-neutral readiness и local/PostgreSQL resume canary.

### Риск: upstream updater ослабит локальную транзакцию

**Решение:** переносится UI/progress идея, а не upstream update engine.

### Риск: update notification станет шумной

**Решение:** дедупликация по target commit, opt-in timer, одна notification на версию/commit.

### Риск: stable AI SDK меняет provider body

**Решение:** отдельный dependency PR, body-level provider tests и live release canary.

### Риск: Eve переносит local Workflow state внутрь `.eve`

**Решение:** backup только точного personal subtree, atomic copy-and-activate из legacy path,
идемпотентный повторный update и сохранение legacy state для rollback. Весь `.eve` никогда не
классифицируется как пользовательские данные.

### Риск: смешение Eve upgrade с новой beta-версией PostgreSQL World

**Решение:** сохранить `@workflow/world-postgres@5.0.0-beta.23`; отдельный Workflow-only PR возможен
после Stage 8 soak.

### Риск: жёсткое rich-report правило ухудшит обычный диалог

**Решение:** deterministic content-based routing и сохранение коротких plain/HTML ответов.

## 15. Non-goals

- web dashboard настройки моделей;
- ввод или ротация provider secrets через Telegram;
- автоматический выбор «самой дешёвой» модели;
- автоматический fallback на другой платный provider без разрешения;
- изменение context window через `/model`;
- автоматический production update по timer;
- превращение `upstream/main` в production channel;
- одновременная миграция Autograph/live vault;
- отказ от текущего PostgreSQL Workflow profile, doctor, backup/restore или observability.

## 16. Итоговый Definition of Done

Цикл считается завершённым, когда:

- все восемь функций либо внедрены, либо Stage 7 явно отложен как optional с зафиксированным решением;
- `/model` раздельно и безопасно управляет text и vision ролями;
- `/think` честно работает только на поддерживаемом text provider;
- старые `.env` не требуют ручной миграции;
- bash и memory guards доказаны behavioral tests;
- rich reports используют существующий transport с fallback;
- update UI не ослабил staging/migration/backup/readiness rollback;
- ежедневная проверка только уведомляет и уважает persistent `origin/main` channel;
- Eve/AI SDK upgrade прошёл полный release matrix;
- `CODEBASE_MAP.md`, configuration/CLI/deploy/testing docs и capability snapshot соответствуют
  реализованной ответственности;
- production не использовался для automated verification и не был изменён без отдельного разрешения.
