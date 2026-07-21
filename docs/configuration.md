# Configuration

Iva is configured by one file: `.env` in the install directory. The setup wizard fills it in for you — run `iva config` any time to redo a step ([cli.md](./cli.md)). `.env.example` in the repo root is the template. This page documents every variable.

**Every change needs a restart.** Iva reads `.env` once at startup. After editing:

```bash
iva restart
```

No rebuild. Swapping a model, key or provider is edit → restart.

## Model provider

Four providers are available. `MODEL_PROVIDER` selects text; optional `VISION_PROVIDER` can select a
different already-configured provider for images. Fill the text provider block and, only when vision
uses another provider, that provider's credentials/model fields too. `ollama`/`opencode`/`openrouter`
use OpenAI-compatible API keys; `codex` rides your OpenAI (ChatGPT) subscription via OAuth. Prices and
full model lists: [providers.md](./providers.md).

| Variable | Default | Notes |
|---|---|---|
| `MODEL_PROVIDER` | `ollama` | `ollama` (Ollama Cloud), `opencode` (OpenCode Zen), `openrouter` (OpenRouter) or `codex` (OpenAI ChatGPT subscription). |
| `VISION_PROVIDER` | `MODEL_PROVIDER` | Optional independent provider for image description/OCR. It must already have credentials or Codex OAuth configured. Unset preserves the legacy same-provider route. |
| `THINKING_EFFORT` | *(unset)* | Text reasoning effort: `minimal`, `low`, `medium` or `high`. Currently applied only to Codex; it never changes vision. |
| `OLLAMA_API_KEY` | — | Key from ollama.com. |
| `OLLAMA_MODEL` | `deepseek-v4-pro` | Any model on your Ollama Cloud plan. |
| `OLLAMA_VISION_MODEL` | `minimax-m3` | Multimodal model used for images. When omitted, vision stays on MiniMax M3; set an override only for an intentional replacement. |
| `OLLAMA_BASE_URL` | `https://ollama.com/v1` | Optional OpenAI-compatible Ollama endpoint override; useful for self-hosted instances and isolated tests. |
| `OLLAMA_CONTEXT_WINDOW` | `131072` | See warning below. |
| `OPENCODE_API_KEY` | — | Key from opencode.ai/auth. |
| `OPENCODE_MODEL` | `opencode-go/deepseek-v4-pro` | Any Zen Go model. |
| `OPENCODE_VISION_MODEL` | `gemini-3-flash` | OpenCode model used when the resolved vision provider is `opencode`. |
| `OPENCODE_CONTEXT_WINDOW` | `131072` | Same warning. |
| `OPENROUTER_API_KEY` | — | Key from [openrouter.ai/keys](https://openrouter.ai/keys) (starts with `sk-or-`). |
| `OPENROUTER_MODEL` | `openai/gpt-5.1` | The model **slug** from [openrouter.ai/models](https://openrouter.ai/models), form `vendor/model` (e.g. `anthropic/claude-sonnet-4.5`). `iva config` sends a live test request so a wrong slug can't slip through. |
| `OPENROUTER_VISION_MODEL` | `google/gemini-2.5-flash` | Multimodal OpenRouter slug used when the resolved vision provider is `openrouter`. |
| `OPENROUTER_CONTEXT_WINDOW` | `131072` | Same warning — set the real window of the model you picked. |
| `CODEX_MODEL` | `gpt-5.5` | Model from your OpenAI plan. `iva config` lists what your subscription actually exposes. |
| `CODEX_VISION_MODEL` | `CODEX_MODEL` | Optional Codex vision override; unset keeps the same Codex model for both roles. |
| `CODEX_CONTEXT_WINDOW` | `272000` | Same warning — set the real window of the model you picked. |

For `codex` there is no API key in `.env`: run `iva login` (device code, headless-friendly) or `iva login --browser`. The OAuth token lives in `data/codex-auth.json` (chmod 600, gitignored) and is auto-refreshed before it expires. Full flow: [providers.md](./providers.md#openai-by-chatgpt-subscription-codex).

**Don't inflate the context window.** Compaction triggers at 70% of this number. Set it above the model's real window and the compactor fires too late — the request overflows before history gets trimmed. When you switch models, enter the new model's actual window, not a rounder bigger one.

## Telegram

| Variable | Default | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | From [@BotFather](https://t.me/BotFather). |
| `TELEGRAM_BOT_USERNAME` | — | Your bot's username. The wizard verifies the token via `getMe` and detects this itself. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | — | Shared secret between the long-poll bridge and the local webhook. Any long random string. |
| `TELEGRAM_ALLOWED_USER_IDS` | *(empty)* | Comma-separated numeric user IDs allowed to talk to Iva. |
| `TELEGRAM_DIGEST_CHAT_ID` | — | Chat that receives the morning digest and nightly memory reports. Usually your own chat ID. |
| `IVA_UPDATE_CHECK_ENABLED` | `false` | Opt-in daily read-only check of the private `origin/main` update channel. Sends one Telegram offer per target commit; never installs automatically. Prefer `iva update-check on|off` over manual editing. |

The allowlist is **fail-closed: empty means Iva answers nobody.** The wizard auto-discovers your ID the moment you message the bot; or ask [@userinfobot](https://t.me/userinfobot). Why fail-closed matters: [security.md](./security.md).

### Personal Telegram userbot (beta, opt-in)

The personal-account MCP proxy is shipped but disabled by default. It is separate from
the ordinary Telegram bot above and must never be required for normal startup, doctor, polling or
reminders. If it is evaluated later, begin on a test account with `TELEGRAM_EXPOSED_TOOLS=read-only`;
`all` exposes account mutations and requires a separate security review. Read-only mode exposes 49
upstream tools plus four onboarding tools. The proxy is restricted to loopback and its upstream
dependency is pinned to an exact audited commit. See [userbot.md](./userbot.md).

## Voice

| Variable | Default | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | From console.deepgram.com. Transcribes voice notes, video circles and audio files. Free tier: [providers.md](./providers.md). |
| `DEEPGRAM_LANGUAGE` | `multi` | `multi` auto-detects the language per message (ru/uz/en and others). Pin a single code like `en` only if auto-detection trips on your mix. |

## Search

| Variable | Default | Notes |
|---|---|---|
| `SEARCH_PROVIDER` | `tavily` | `tavily`, `exa`, `parallel` or `brave`. |
| `TAVILY_API_KEY` `EXA_API_KEY` `PARALLEL_API_KEY` `BRAVE_API_KEY` | — | Key for the matching provider. Keys can coexist; switching providers is just the flag. |

No key for the active provider means `web_search` returns a clear error — nothing crashes. Free tiers and the comparison table: [providers.md](./providers.md).

## Memory

| Variable | Default | Notes |
|---|---|---|
| `MEMORY_SEARCH_MODE` | `grep` | `grep` = BM25 over Node's built-in SQLite FTS5 plus graph rerank. Zero external deps, zero keys, runs on a $4 box. `hybrid` adds dense embeddings — one external key. |
| `JINA_API_KEY` | — | For hybrid. Jina `jina-embeddings-v3`: no-train policy, EU hosting. |
| `DEEPINFRA_API_KEY` | — | For hybrid. Cheaper, serves `BAAI/bge-m3`. One of the two keys is enough. |
| `MEMORY_EMBED_PROVIDER` | *(auto)* | Override auto-pick: `jina` or `deepinfra`. |
| `MEMORY_EMBED_MODEL` | `jina-embeddings-v3` | Embedding model name. |
| `MEMORY_EMBED_URL` | — | Any OpenAI-compatible embeddings endpoint, e.g. a local Ollama at `http://127.0.0.1:11434/v1/embeddings` — then no external key at all. |

The nightly doctor builds the hybrid index; to build it now, run `node --env-file=.env scripts/memory/embed-index.ts`. How search actually works: [memory.md](./memory.md).

## System

| Variable | Default | Notes |
|---|---|---|
| `AGENT_LANGUAGE` | `ru` | `en` or `ru`. Sets Iva's reply language, date locale, and which CORE.md seed `init-vault` uses. |
| `ASSISTANT_TIMEZONE` | `Asia/Almaty` | IANA name. Sets daily-transcript dates, the 5 nightly memory timers, the optional update-check timer, and the date/time Iva sees each turn. Exported as `TZ`. |
| `ASSISTANT_VAULT_DIR` | `vault` | The live memory: a separate private git repo, opens in Obsidian. |
| `ASSISTANT_DATA_DIR` | `data` | Runtime data: `tasks.json`, `reminders.json`, token log `usage.jsonl`. |
| `IVA_PORT` | `8723` | Local eve server port. Deliberately unfashionable — 3000/8000/8080 are usually taken on a stock VPS by docker and friends. Change it via `iva config`, not by hand: the systemd unit pins the port literally and must match ([deploy.md](./deploy.md)). |
| `ASSISTANT_HOST` | `http://127.0.0.1:${IVA_PORT}` | Where the poll bridge and memory scripts reach the server. Change only if the agent runs on another host. |
| `ASSISTANT_BEARER` | *(empty)* | Only when the eve HTTP channel requires a bearer token — the Vercel variant in [deploy.md](./deploy.md). |
| `AGENT_BROWSER_MAX_OUTPUT` | `24000` | Character cap on agent-browser output, so one page dump can't eat the context window. |

## Workflow backend

Leave these unset for the default local `.eve/.workflow-data` backend. Iva migrates the legacy
`.workflow-data` layout during the Eve 0.24 upgrade and preserves the legacy copy for rollback. Do
not configure `WORKFLOW_LOCAL_DATA_DIR`: Eve owns the local path. For long-running self-host installs,
enable the official PostgreSQL Workflow World:

| Variable | Default | Notes |
|---|---|---|
| `WORKFLOW_TARGET_WORLD` | `local` | The only other accepted value is `@workflow/world-postgres`. This is a build and runtime profile; rebuild after changing it. |
| `WORKFLOW_POSTGRES_URL` | — | PostgreSQL connection string. Local socket example: `postgresql:///iva_workflow?host=/var/run/postgresql`; with peer auth this expects a PostgreSQL role matching the service user. |
| `WORKFLOW_QUEUE_NAMESPACE` | `eve` | Queue namespace expected by the generated eve workflow routes. |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | `iva_` | Prefix for graphile-worker job names. |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | `8` | Conservative default for a tiny single-user VPS. |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE` | `10` | Keep below PostgreSQL `max_connections` after system overhead. |

For a supported self-host setup, run `iva workflow-postgres enable`; it discovers the installed
PostgreSQL version/config/socket and the actual service user, bootstraps and validates the schema,
builds the matching profile, and proves restart/resume. It remains an advanced opt-in and does not
change the normal setup wizard. The optional workflow environment file is loaded before `.env`, so
`.env` wins when both define the selector. `npm run build` records a sanitized descriptor in
`.output`; startup and `iva doctor` reject a build/runtime mismatch before Iva accepts messages.
Full preflight and failure semantics: [deploy.md](./deploy.md#workflow-backend).
