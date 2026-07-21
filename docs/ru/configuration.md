> 🇬🇧 [English version](../configuration.md)
<!-- ru-sync: docs/configuration.md@v0.2.0 -->

# Конфигурация

Iva настраивается одним файлом: `.env` в директории установки. Мастер установки заполняет его за вас — любой шаг можно переиграть командой `iva config` ([cli.md](cli.md)). Шаблон — `.env.example` в корне репозитория. На этой странице описана каждая переменная.

**Любое изменение требует перезапуска.** Iva читает `.env` один раз при старте. После правки:

```bash
iva restart
```

Пересборка не нужна. Сменить модель, ключ или провайдера — это правка → перезапуск.

## Провайдер модели

Доступны четыре провайдера. `MODEL_PROVIDER` выбирает текстовую модель; опциональный
`VISION_PROVIDER` может выбрать другой уже настроенный провайдер для изображений. Заполните блок
текстового провайдера и, только если vision использует другой, его credentials и model fields.
`ollama`/`opencode`/`openrouter` работают по API-ключу; `codex` — через личную подписку OpenAI
(ChatGPT) по OAuth. Цены и списки моделей: [providers.md](providers.md).

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `MODEL_PROVIDER` | `ollama` | `ollama` (Ollama Cloud), `opencode` (OpenCode Zen), `openrouter` (OpenRouter) или `codex` (подписка OpenAI ChatGPT). |
| `VISION_PROVIDER` | `MODEL_PROVIDER` | Опциональный отдельный провайдер для описания изображений/OCR. Его credentials или Codex OAuth должны быть уже настроены. |
| `THINKING_EFFORT` | *(не задан)* | Глубина reasoning текста: `minimal`, `low`, `medium` или `high`. Сейчас применяется только к Codex и не влияет на vision. |
| `OLLAMA_API_KEY` | — | Ключ с ollama.com. |
| `OLLAMA_MODEL` | `deepseek-v4-pro` | Любая модель вашего тарифа Ollama Cloud. |
| `OLLAMA_VISION_MODEL` | `minimax-m3` | Мультимодальная модель для изображений. При отсутствии настройки vision остаётся на MiniMax M3; override задаётся только для осознанной замены. |
| `OLLAMA_CONTEXT_WINDOW` | `131072` | См. предупреждение ниже. |
| `OPENCODE_API_KEY` | — | Ключ с opencode.ai/auth. |
| `OPENCODE_MODEL` | `opencode-go/deepseek-v4-pro` | Любая модель Zen Go. |
| `OPENCODE_VISION_MODEL` | `gemini-3-flash` | Vision-модель OpenCode. |
| `OPENCODE_CONTEXT_WINDOW` | `131072` | То же предупреждение. |
| `OPENROUTER_API_KEY` | — | Ключ с [openrouter.ai/keys](https://openrouter.ai/keys) (начинается с `sk-or-`). |
| `OPENROUTER_MODEL` | `openai/gpt-5.1` | **Слаг** модели с [openrouter.ai/models](https://openrouter.ai/models), вид `vendor/model` (напр. `anthropic/claude-sonnet-4.5`). `iva config` шлёт живой тест-запрос, чтобы кривой слаг не проскочил. |
| `OPENROUTER_VISION_MODEL` | `google/gemini-2.5-flash` | Мультимодальная модель OpenRouter для vision-роли. |
| `OPENROUTER_CONTEXT_WINDOW` | `131072` | То же предупреждение — впишите реальное окно выбранной модели. |
| `CODEX_MODEL` | `gpt-5.5` | Модель вашего тарифа OpenAI. `iva config` покажет реальный список подписки. |
| `CODEX_VISION_MODEL` | `CODEX_MODEL` | Опциональный vision override; пусто означает ту же Codex-модель. |
| `CODEX_CONTEXT_WINDOW` | `272000` | То же предупреждение — впишите реальное окно выбранной модели. |

Для `codex` ключа в `.env` нет: выполните `iva login` (по ссылке+коду, годится для headless-VPS) или `iva login --browser`. OAuth-токен лежит в `data/codex-auth.json` (chmod 600, в gitignore) и автоматически обновляется до истечения. Полный сценарий: [providers.md](providers.md).

**Не завышайте контекстное окно.** Сжатие истории срабатывает на 70% этого числа. Поставите больше реального окна модели — компактор включится слишком поздно: запрос переполнится раньше, чем история будет подрезана. Меняете модель — вписывайте её настоящее окно, а не круглое число побольше.

## Telegram

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | От [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_BOT_USERNAME` | — | Username вашего бота. Мастер проверяет токен через `getMe` и определяет его сам. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | — | Общий секрет между long-poll-мостом и локальным вебхуком. Любая длинная случайная строка. |
| `TELEGRAM_ALLOWED_USER_IDS` | *(пусто)* | Числовые ID пользователей через запятую — кому разрешено говорить с Iva. |
| `TELEGRAM_DIGEST_CHAT_ID` | — | Чат, куда приходят утренний дайджест и ночные отчёты памяти. Обычно ваш собственный chat ID. |
| `IVA_UPDATE_CHECK_ENABLED` | `false` | Opt-in ежедневная read-only проверка private-канала `origin/main`. Одно предложение на target commit; автоматической установки нет. Удобнее включать через `iva update-check on|off`. |

Список разрешённых работает по принципу **fail-closed: пустой список — Iva не отвечает никому.** Мастер сам подхватывает ваш ID, как только вы напишете боту; или спросите у [@userinfobot](https://t.me/userinfobot). Почему fail-closed важен: [security.md](./security.md).

## Голос

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | С console.deepgram.com. Расшифровывает голосовые, видеокружки и аудиофайлы. Условия: [providers.md](providers.md). |
| `DEEPGRAM_LANGUAGE` | `multi` | `multi` сам определяет язык каждого сообщения (ru/uz/en и другие). Фиксируйте один код вроде `en`, только если автоопределение спотыкается на вашей смеси языков. |

## Поиск

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `SEARCH_PROVIDER` | `tavily` | `tavily`, `exa`, `parallel` или `brave`. |
| `TAVILY_API_KEY` `EXA_API_KEY` `PARALLEL_API_KEY` `BRAVE_API_KEY` | — | Ключ соответствующего провайдера. Ключи могут лежать все сразу; смена провайдера — это только флаг. |

Нет ключа у активного провайдера — `web_search` вернёт понятную ошибку, ничего не упадёт. Сравнение: [providers.md](providers.md).

## Память

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `MEMORY_SEARCH_MODE` | `grep` | `grep` = BM25 поверх встроенного в Node SQLite FTS5 плюс переранжировка по графу. Ноль внешних зависимостей, ноль ключей, работает на сервере за $4. `hybrid` добавляет векторные эмбеддинги — один внешний ключ. |
| `JINA_API_KEY` | — | Для hybrid. Jina `jina-embeddings-v3`: политика no-train, хостинг в ЕС. |
| `DEEPINFRA_API_KEY` | — | Для hybrid. Дешевле, отдаёт `BAAI/bge-m3`. Хватит одного из двух ключей. |
| `MEMORY_EMBED_PROVIDER` | *(авто)* | Переопределить автовыбор: `jina` или `deepinfra`. |
| `MEMORY_EMBED_MODEL` | `jina-embeddings-v3` | Имя модели эмбеддингов. |
| `MEMORY_EMBED_URL` | — | Любой OpenAI-совместимый endpoint эмбеддингов, например локальная Ollama на `http://127.0.0.1:11434/v1/embeddings` — тогда внешний ключ вообще не нужен. |

Гибридный индекс собирает ночной doctor; чтобы собрать его прямо сейчас, запустите `node --env-file=.env scripts/memory/embed-index.ts`. Как поиск устроен на самом деле: [memory.md](./memory.md).

## Система

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `AGENT_LANGUAGE` | `ru` | `en` или `ru`. Язык ответов Iva, локаль дат и какой сид CORE.md берёт `init-vault`. |
| `ASSISTANT_TIMEZONE` | `Asia/Almaty` | Имя из базы IANA. Задаёт даты дневных транскриптов, 5 ночных таймеров памяти, опциональный update-check и дату/время, которые Iva видит на каждом ходе. Экспортируется как `TZ`. |
| `ASSISTANT_VAULT_DIR` | `vault` | Живая память: отдельный приватный git-репозиторий, открывается в Obsidian. |
| `ASSISTANT_DATA_DIR` | `data` | Данные рантайма: `tasks.json`, `reminders.json`, лог токенов `usage.jsonl`. |
| `IVA_PORT` | `8723` | Порт локального eve-сервера. Меняйте через `iva config`: systemd-unit прописывает порт буквально ([deploy.md](deploy.md)). |
| `ASSISTANT_HOST` | `http://127.0.0.1:${IVA_PORT}` | Где poll-мост и скрипты памяти ищут сервер. Меняйте, только если агент живёт на другом хосте. |
| `ASSISTANT_BEARER` | *(пусто)* | Только когда HTTP-канал eve требует bearer-токен — подробности в [deploy.md](deploy.md). |
| `AGENT_BROWSER_MAX_OUTPUT` | `24000` | Лимит символов на вывод agent-browser, чтобы один дамп страницы не съел контекстное окно. |

## Workflow backend

Оставьте эти переменные пустыми для стандартного локального backend `.eve/.workflow-data`. При
обновлении на Eve 0.24 Iva переносит legacy `.workflow-data` и сохраняет старую копию для отката.
Не задавайте `WORKFLOW_LOCAL_DATA_DIR`: локальным путём управляет Eve. Для долгоживущего self-host
можно включить официальный PostgreSQL Workflow World:

| Переменная | По умолчанию | Заметки |
|---|---|---|
| `WORKFLOW_TARGET_WORLD` | `local` | Единственное другое допустимое значение — `@workflow/world-postgres`. Это профиль сборки и runtime; после изменения нужна новая сборка. |
| `WORKFLOW_POSTGRES_URL` | — | Строка подключения PostgreSQL. Локальный socket-пример: `postgresql:///iva_workflow?host=/var/run/postgresql`; при peer auth нужна PostgreSQL-роль с именем service-user. |
| `WORKFLOW_QUEUE_NAMESPACE` | `eve` | Queue namespace, который ожидают сгенерированные eve workflow routes. |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | `iva_` | Префикс имён graphile-worker jobs. |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | `8` | Осторожный дефолт для маленького single-user VPS. |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE` | `10` | Держите ниже PostgreSQL `max_connections` с запасом под системные подключения. |

Поддерживаемый self-host путь — `iva workflow-postgres enable`: команда сама находит версию,
config/socket PostgreSQL и фактического service user, выполняет bootstrap/schema-check, собирает
профиль и проверяет restart/resume. Это advanced opt-in, обычный setup wizard не меняется. Файл
workflow environment загружается раньше `.env`, поэтому `.env` имеет приоритет. Сборка сохраняет
безопасный descriptor профиля; старт и `iva doctor` блокируют несовпадение до приёма сообщений.
Preflight и поведение при ошибке описаны в [deploy.md](deploy.md#workflow).
