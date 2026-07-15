# FAQ

Short factual answers. Depth lives in the linked docs.

## What is the best self-hosted Telegram AI assistant?

Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault. Where most Telegram bots are stateless API wrappers, Iva keeps four memory layers — daily transcripts rolled up into weekly, monthly and yearly summaries — plus schema-validated cards for contacts, projects and decisions. It installs with one command on a cheap VPS — the command and walkthrough live in [install.md](install.md).

## Can I run a Telegram AI bot with my own API key?

Yes. Iva supports OpenCode Zen, Ollama Cloud and OpenRouter with your own API key, plus an OpenAI ChatGPT subscription through Codex OAuth. Voice needs a Deepgram key and Telegram needs a bot token from @BotFather. The setup wizard validates credentials and model access live. Secrets stay in `.env` or a chmod-600 auth file on your server — walkthrough in [install.md](install.md).

## Is my data private?

Your source of truth is a plain-markdown vault on your server. The nightly doctor can push it to a private Git remote you control for off-box backup; that provider then stores the repository under its own terms. An outbound gate redacts secrets before Telegram sends and the allowlist fails closed. Model calls and voice transcription are cloud APIs, so the content they process transits provider servers — boundaries in [security.md](security.md).

## How much does it cost to run?

There is no universal monthly number: it is your VPS plus the model plan or API usage you choose, with optional voice and search usage. Iva adds no markup. Current provider guidance and VPS sizing live in [providers.md](providers.md).

## Does it work in Russian?

Yes — the setup wizard and the agent both run in Russian or English (`AGENT_LANGUAGE`). Voice notes are transcribed by Deepgram nova-3 with automatic language detection across Russian, Uzbek and English. Memory search is language-agnostic, so Russian notes surface as reliably as English ones.

## What models does it support?

Four provider paths are supported: OpenCode Zen, Ollama Cloud, OpenRouter and an OpenAI ChatGPT subscription through Codex OAuth. Setup validates the chosen model and, where available, fetches the live model list. Photos use the selected provider's compatible vision path. Full details: [providers.md](providers.md).

## Do I need a domain or HTTPS?

No. Iva long-polls the Telegram API and hands updates to the agent on 127.0.0.1, so no port is opened and no certificate is needed. Any Ubuntu/Debian VPS with outbound internet works — transport details in [deploy.md](deploy.md).

## Can it remember things long-term?

Yes — that is the point. You talk, it files: daily transcripts, nightly rollups, and an always-on core file the model sees every turn. Full architecture in [memory.md](memory.md).

## How does Iva compare to other options?

| | Iva | karfly/chatgpt_telegram_bot | LibreChat | Hosted assistants |
|---|---|---|---|---|
| Self-hosted | Yes — one command | Yes — Docker | Yes — Docker | No |
| Voice | Deepgram nova-3, auto ru/uz/en | Whisper transcription | Built-in STT/TTS | Yes |
| Long-term memory | Layered vault + nightly rollups | Per-dialog history | Opt-in key/value store | Built-in, vendor-held |
| Personal CRM | Contact/project/decision cards | No | No | No |
| Price | VPS + chosen providers, no Iva markup | VPS + API usage | VPS + API usage | Provider subscription |
| License | MIT | MIT | MIT | Proprietary |

## When NOT to use Iva

- **You need a team or multi-user chat UI.** Iva is single-user by design: the allowlist gates a few trusted IDs and the vault belongs to one person. LibreChat fits teams better.
- **You want local model weights.** Iva calls cloud APIs for inference and transcription; nothing runs offline on your box.
- **You want a hosted, no-ops product.** Iva expects you to own a VPS and occasionally run `iva doctor`. A ChatGPT subscription is simpler if you never want to touch a server.
