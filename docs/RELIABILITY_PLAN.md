# План стабилизации Iva: Workflow runtime, Autograph и эксплуатация

Дата фиксации: 2026-06-27  
Статус: утверждён к реализации

## 1. Цель

Устранить устойчивую деградацию CPU и рост `.workflow-data`, не уменьшая возможности
ассистента и не меняя семантику долговременной памяти Autograph.

Ожидаемый результат:

- idle CPU Eve в среднем ниже 5%;
- перезапуски процесса не теряют текущую сессию;
- больше не требуется ручной reset `.workflow-data` каждые несколько дней;
- модель, reasoning, контекст, инструменты, MCP, субагенты и Autograph работают как раньше;
- health-алерты vault отражают реальные дефекты, а не raw-транскрипты или ожидаемые будущие ссылки;
- напоминания проверяются раз в 5 минут вместо раза в минуту.

## 2. Подтверждённая причина

`@workflow/world-local`, встроенный в Eve, хранит каждый stream event отдельным файлом в
плоском каталоге `.workflow-data/streams/chunks`. Для каждого открытого stream каталог
полностью перечитывается каждые 100 мс.

На production VPS к моменту диагностики:

- 18 292 stream chunk-файла (позже каталог `.workflow-data` вырос до 350 МБ);
- четыре незавершённых stream без EOF;
- каждый ночной rollup создавал новую интерактивную Eve-сессию со статусом `waiting`;
- основную массу файлов составляли `reasoning.appended` и `message.appended`;
- каждый append содержал delta и полный накопленный `reasoningSoFar`/`messageSoFar`;
- CPU Eve держался около 60–100%, load average был выше 2 на одном vCPU;
- I/O диска не являлся узким местом — CPU уходил на повторные обходы каталога и обработку файлов.

Это дефект/ограничение execution backend, а не Autograph и не Markdown vault.

## 3. Архитектурное решение

Разделить execution state и долговременную память:

```text
Telegram / Eve sessions / steps / streams  -> PostgreSQL Workflow World
Долговременная память                      -> Markdown vault + Autograph
Задачи и напоминания                       -> data/*.json
Производные индексы                        -> vault/.graph (пересобираемые)
```

Файловый `world-local` заменить на `@workflow/world-postgres`. PostgreSQL World хранит
runs, events, steps, hooks и stream chunks в индексированных таблицах, использует
Graphile Worker для очереди и LISTEN/NOTIFY для live-streaming.

Источники:

- Eve self-hosted deployment и custom Workflow World:
  https://github.com/vercel/eve/blob/main/docs/guides/deployment.md
- Workflow Worlds: https://workflow-sdk.dev/worlds
- Postgres World: https://workflow-sdk.dev/worlds/postgres
- Autograph: https://github.com/smixs/autograph
- Agent Second Brain: https://github.com/smixs/agent-second-brain

## 4. Инварианты: что менять запрещено

В рамках исправления не меняются:

- модель `deepseek-v4-pro` и provider;
- context window 131 072 токена;
- compaction threshold `0.7`;
- reasoning и качество model output;
- системные инструкции и характер Iva;
- authored/framework tools, MCP, browser и planner;
- Telegram, voice, vision и web search;
- динамическая CORE-инъекция на каждом turn;
- структура vault и Markdown как source of truth;
- schema, decay, tiers, MOC и DAG Autograph;
- append-only raw daily transcripts;
- LLM-консолидация daily/weekly/monthly/yearly.

Перед production cutover `/eve/v1/info` до и после сравнивается по модели, context window,
tools, skills, channels, hooks, connections и subagents. Любое необъяснённое отличие блокирует
релиз.

## 5. Оценка текущего VPS

Снимок 2026-06-27:

| Ресурс | Состояние | Оценка |
|---|---:|---|
| CPU | 1 vCPU, DigitalOcean Regular, 2.0 GHz | Достаточно для single-user Iva; текущая загрузка вызвана bug loop |
| RAM | 961 МБ, доступно около 383 МБ под текущей нагрузкой | Впритык, но допустимо для настроенного PostgreSQL |
| Swap | 1 ГБ, занято около 181 МБ | Увеличить до 2 ГБ перед Postgres |
| Диск | 24 ГБ, свободно около 16 ГБ | Достаточно; включить мониторинг роста DB |
| Файловая система | ext4, inode usage 9% | Достаточно |
| I/O | iowait около 0%, latency диска низкая | Не является ограничением |
| ОС | Ubuntu 24.04.3 LTS | PostgreSQL 16.14 доступен штатно |

Вывод: VPS подходит без увеличения тарифа при следующих ограничениях:

- PostgreSQL `shared_buffers=64MB`;
- `work_mem=2MB`, `maintenance_work_mem=32MB`;
- `max_connections=30`;
- Workflow worker concurrency `8`;
- pool size `10`;
- swap 2 ГБ;
- PostgreSQL слушает только localhost;
- если после cutover RAM устойчиво выше 80% или swap активно растёт, переносится только
  PostgreSQL в managed instance — модель и Iva не урезаются.

## 6. Целевые версии

Первый релиз должен быть минимальным и не смешивать storage migration с переходом всего AI stack:

- `eve`: exact `0.11.10`;
- `@workflow/world-postgres`: exact `5.0.0-beta.16`;
- `ai`: оставить `7.0.0-beta.178`;
- `@ai-sdk/openai-compatible`: оставить `3.0.0-beta.57`;
- `zod`: оставить `4.4.3`;
- Node.js: оставить `24.17.0`/24.x;
- PostgreSQL: 16.x.

Eve 0.11.9 добавила `experimental.workflow.world`; 0.11.10 сохраняет используемую Iva
ветку AI SDK и текущий протокол инструментов. Обновление до 0.13/0.16 выполняется позже,
отдельно, только через staging. Preview-зависимости пинятся без `^`.

## 7. Этапы реализации

### Этап A. Немедленная стабилизация

1. Зафиксировать baseline `/eve/v1/info`, CPU/RAM, размеры runtime и vault.
2. Остановить Telegram polling, чтобы не принять сообщение во время обслуживания.
3. Дождаться завершения активного turn.
4. Сохранить краткий migration handoff текущей сессии.
5. Закоммитить и запушить live vault.
6. Остановить Eve.
7. Архивировать `.workflow-data` с timestamp, не удалять.
8. Запустить Eve и polling с чистым временным runtime.
9. Проверить Telegram и CPU.

Это временно возвращает отзывчивость и даёт окно на staging. Плановый простой: 5–10 минут.

### Этап B. PostgreSQL и staging

1. Увеличить swap до 2 ГБ идемпотентно.
2. Установить PostgreSQL 16 и применить консервативный memory profile.
3. Создать отдельные role/database для Workflow, доступ только localhost.
4. Установить точно зафиксированные версии Eve и Postgres World.
5. Добавить в root `agent.ts`:

   ```ts
   experimental: {
     workflow: {
       world: "@workflow/world-postgres",
     },
   }
   ```

6. Добавить runtime env для PostgreSQL, worker concurrency и pool size.
7. Выполнить идемпотентный bootstrap/migrations Postgres World.
8. Собрать staging на другом порту с отдельной test DB и копией vault.
9. Не подключать staging к реальному Telegram polling.

### Этап C. Staging quality gate

Проверить:

1. два последовательных сообщения продолжают одну сессию;
2. CORE перечитывается на каждом turn;
3. все authored tools доступны и выполняются;
4. tasks/reminders работают;
5. web search/fetch и Telegram MCP работают;
6. planner-subagent работает;
7. restart Eve между ходами сохраняет сессию;
8. crash между steps возобновляется с checkpoint;
9. daily rollup на test vault создаёт корректные cards/summary;
10. существующие тесты Autograph проходят полностью;
11. manifest `/eve/v1/info` не потерял capability;
12. idle CPU staging остаётся ниже 5%;
13. в staging не создаётся новый плоский `.workflow-data/streams/chunks`.

### Этап D. Production cutover

1. Vault backup и проверка git remote.
2. Остановить polling и дождаться parked turn.
3. Выполнить PostgreSQL migrations.
4. Остановить Eve.
5. Сохранить старые `.output` и `.workflow-data`.
6. Установить проверенный staging build.
7. Запустить PostgreSQL, Eve, Telegram MCP и polling.
8. Выполнить canary: обычный ответ, tool call, memory recall, reminder.
9. Наблюдать CPU/RAM/queue/errors минимум час и повторно через 24 часа.

Старый runtime хранится семь дней для аварийного rollback. Vault при смене World не
мигрируется и не изменяется.

## 8. Ремонт интеграции Autograph

Выполняется отдельным изменением после стабилизации runtime.

Подтверждённые проблемы:

- `enforce.py` вызывается без обязательного `schema.json`;
- doctor не запускает enforce;
- health считается до части обслуживающих операций;
- raw daily penalized за отсутствие card frontmatter/description;
- CORE и MOC ошибочно попадают в orphans;
- намеренные future links `daily -> weekly -> monthly -> yearly` считаются broken;
- на снимке 2026-06-27 у 17 cards и четырёх daily-summary отсутствует description;
- daily/weekly/monthly/yearly/doctor не используют общий lock и могут писать vault параллельно.

Изменения:

1. Передавать `.claude/skills/autograph/schema.json` явно.
2. Запускать validation из Node orchestrator после LLM rollup.
3. Ввести единый maintenance lock для всех memory jobs.
4. Порядок doctor:

   ```text
   enforce -> decay -> MOC -> link checks -> health -> git push
   ```

5. В health разделить:
   - managed cards/summaries;
   - raw transcripts;
   - roots/hubs;
   - true broken links;
   - deferred calendar links.
6. Не менять глобальный graph resolution: raw daily остаются узлами и доступны по ссылкам,
   но не влияют на card-compliance score.
7. Добавить regression fixtures для raw daily, CORE, MOC и future links.
8. Исправить текущие карточки отдельным vault-коммитом после review diff; raw daily не переписывать.
9. Health alert слать при конкретном actionable defect, падении >=2 баллов или устойчивом
   score ниже порога, а не при любом снижении на 0.1.

## 9. Напоминания и расписания

`iva-reminders` не вызывает модель, однако минутный timer запускает 1 440 Node-процессов
в сутки. Изменить на:

```ini
[Timer]
OnBootSec=30s
OnCalendar=*-*-* *:0/5:00
AccuracySec=30s
Persistent=true
```

Получится 288 запусков/сутки; допустимая задержка напоминания — до 5 минут.

Отдельно зафиксировать timezone memory timers. Сейчас сервер работает в UTC, поэтому
`04:00` фактически означает 07:00 Europe/Minsk, несмотря на комментарий `local`.
До согласованного изменения часа нужно сохранить текущее фактическое расписание и только
исправить документацию/явно указать timezone.

## 10. Наблюдаемость

Добавить лёгкий direct health guard без вызова Eve/model:

- CPU Eve за 5/15 минут;
- RSS, available RAM и swap activity;
- размер Workflow DB и недельный темп роста;
- queue depth и количество running/waiting/failed runs;
- время последнего успешного rollup/doctor;
- возраст последнего vault git push;
- количество настоящих schema violations;
- deduplicated Telegram alerts с hysteresis.

Пороговые критерии production:

- idle CPU Eve average <5%, sustained idle CPU не выше 15%;
- RAM ниже 80% без постоянного swap-in/swap-out;
- Telegram latency не хуже staging baseline более чем на 10%;
- reminder доставляется в пределах 5 минут;
- restart сохраняет активную сессию;
- ежедневный rollup не создаёт новые незакрытые filesystem streams;
- Autograph tests и schema gate зелёные.

На первом этапе не выполнять самодельное SQL-удаление Workflow rows. Сначала измерить рост
2–4 недели. Затем очищать только terminal batch runs по проверенной схеме; активную Telegram
сессию не трогать.

## 11. Откат

Перед cutover сохраняются:

- предыдущий git commit и lockfile;
- предыдущий `.output`;
- timestamped `.workflow-data`;
- PostgreSQL dump;
- отдельный git commit live vault;
- baseline `/eve/v1/info`.

Если canary не проходит:

1. остановить polling;
2. остановить Eve;
3. вернуть предыдущий build/config;
4. при необходимости вернуть архив `.workflow-data`;
5. запустить Eve и polling;
6. PostgreSQL и vault не удалять до разбора.

## 12. Разбиение изменений

Реализация разбивается на независимые изменения:

1. runtime/PostgreSQL + staging + cutover;
2. Autograph validation, truthful health и maintenance locking;
3. monitoring, timer раз в 5 минут и документация;
4. отдельная будущая миграция Eve после периода стабильности.

Так storage fix не смешивается с изменениями модели или памяти, а каждый шаг имеет
отдельный quality gate и rollback.
