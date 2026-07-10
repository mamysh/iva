# Providers & cost

Iva runs on your server with your keys. Provider prices, model availability and regional access change, so
there is no universal monthly total: check the provider before paying and set a spending cap where offered.

## Model providers

| Provider | Price | Text models | Vision |
|---|---|---|---|
| **OpenCode Zen** | pay-as-you-go; initial balance and processing fee vary | the live Zen model list | provider-dependent |
| **Ollama Cloud** | free tier; Pro is $20/mo | the live Ollama Cloud model list | provider-dependent |
| **OpenRouter** | pay-as-you-go | 300+ models across vendors — pick any slug (`vendor/model`) | `google/gemini-2.5-flash` |
| **OpenAI (ChatGPT subscription)** | your existing Plus/Pro/Team | the models your plan exposes (`gpt-5.x`, `-codex`), fetched live | same subscription (multimodal) |

The first three are plain API keys; the last rides your personal OpenAI subscription:

- 🔌 **OpenAI-compatible** — Zen, Ollama and OpenRouter share the same wire format, so switching is one line in `.env`
- 🌍 **Availability varies** — confirm that a provider accepts your country, payment method and server location.
- 💸 **No Iva usage markup** — you pay the provider directly under its own terms.

```bash
MODEL_PROVIDER=opencode   # or ollama / openrouter / codex, then `iva restart`
```

Start with the provider that works for your region and budget. Keys, model pick and context-window settings live in [configuration.md](configuration.md).

### OpenAI by ChatGPT subscription (`codex`)

Use the OpenAI subscription you already pay for — no separate API key, no per-token bill. Iva signs in the same way the official `codex` CLI does (OAuth against `auth.openai.com`), stores a refreshable token in `data/codex-auth.json` (chmod 600), and calls the subscription's Responses backend directly. The access token is refreshed automatically before it expires.

```bash
iva login              # device code: opens a link + one-time code (works on a headless VPS)
iva login --browser    # PKCE flow: opens a browser on this machine
iva config             # pick the provider (option 3) and a model from your plan's live list
iva restart
```

Notes: the model list is pulled from your subscription at setup time, so you see the models your plan currently allows; re-run `iva config` when a newly released model should appear. Codex turns deliberately use stateless, inline history (`store:false`) rather than server-side response references, so a multi-turn chat remains usable without persisted backend items. Set `CODEX_CONTEXT_WINDOW` to the real window of the model you picked (compaction derives its threshold from it). Routing a self-hosted assistant through the ChatGPT subscription backend is a grey area under OpenAI's terms — you are using your own subscription on your own server, but weigh that yourself.

### OpenRouter (`openrouter`)

One key for [300+ models](https://openrouter.ai/models) (Anthropic, OpenAI, Google, DeepSeek, Meta…), billed pay-as-you-go. Too many to list, so setup takes the model **slug** from you:

1. Key at [openrouter.ai/keys](https://openrouter.ai/keys) (`sk-or-…`).
2. Copy a slug from [openrouter.ai/models](https://openrouter.ai/models) — the `vendor/model` id under the name (e.g. `anthropic/claude-sonnet-4.5`). The model must support **tool/function calling**: Iva sends tools every turn, so chat-only or image models won't work.
3. `iva config` → provider `4` → paste the key, then the slug. Setup fires a live test **with a tool call** and continues only once the model answers — a mistyped slug or a no-tools model is rejected on the spot, not later as a silent bot.

Set `OPENROUTER_CONTEXT_WINDOW` to the model's real window. Vision runs through `google/gemini-2.5-flash` regardless of your text model (billed to your OpenRouter credit).

## Vision

Attachments are never inlined into the model request. A photo lands in the vault, the agent gets its file path, and the provider's own vision model writes the description — OCR plus visual detail — into the daily transcript. Same key as the text model, no extra subscription.

## VPS sizing

Any Ubuntu/Debian box with at least 1 GB RAM is the practical baseline for the PostgreSQL production profile.
The model runs in the cloud, so larger instances are rarely needed for one user; file-backed installs can use
less. See [install.md](install.md) for low-memory handling.

## Voice — Deepgram

Transcription runs on Deepgram `nova-3` with `language=multi`: Russian, Uzbek and English are detected
automatically, even mixed inside one voice note. Deepgram may offer starter credit; check its current terms.
The Telegram Bot API refuses downloads over 20 MB, so a long video will not transcribe.

## Web search

| Provider | Free tier | Card |
|---|---|---|
| **tavily** (recommended) | provider-defined | check provider |
| **exa** | provider-defined | check provider |
| **parallel** | provider-defined | check provider |
| **brave** | provider-defined | check provider |

Pick one, set `SEARCH_PROVIDER` and its key. No key means no web search — Iva says so instead of guessing. DuckDuckGo scraping was removed on purpose: server IPs get captchas, and a search tool that randomly hits a wall is worse than none.

Optional hybrid memory search adds one more key (Jina or DeepInfra embeddings) — covered in [memory.md](memory.md).

## Cost model

Your total is VPS cost plus model usage or subscription, plus any optional voice/search usage. Use the current
provider pages and your own regional payment terms as the source of truth; the only Iva cost is zero.
