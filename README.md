<div align="center">

**English | [Русский](README.ru.md)**

<img src="assets/iva-header.webp" alt="Iva — personal AI agent with long-term memory" width="100%">

**Your own AI agent. Your server, your memory — one command and it just works.**

```bash
curl -fsSL https://raw.githubusercontent.com/mamysh/iva/codex/iva-prod/install.sh | bash
```

[![Release](https://img.shields.io/github/v/release/mamysh/iva?color=brightgreen)](https://github.com/mamysh/iva/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/mamysh/iva?style=social)](https://github.com/mamysh/iva/stargazers)

</div>

---

## What it is

Iva is a personal AI agent that lives in your Telegram and runs on a server you own. Install it with
one command, then just talk to it — by text or by voice. It answers, and it remembers: your tasks,
decisions, the people and projects you mention. The longer you use it, the better it knows you.

No Iva dashboard or Iva SaaS account. The code and the memory sit on your machine. You bring your
own model-provider key and pick the model; that provider bills you directly under its own terms.

---

## Why Iva

[OpenClaw](https://github.com/openclaw/openclaw), [Hermes](https://github.com/NousResearch/hermes-agent),
[nanobot](https://github.com/HKUDS/nanobot) — there are a lot of good personal agents out there. So why
build another one? Because every one of them hands you the same pile of decisions: which model, which
memory, which search, how to deploy, how to wire it together. Too much choice is the real problem.

So I made the choices. I test agents, models, stacks and harnesses all the time, keep what's actually
best, and fold it into Iva — so you get the result without doing the research. The goal is one thing: a
cheap, fast, reliable agent for every day, the kind that pings you with your morning digest on its own.

- **The best of every agent, in one.** I've been at this a while. The good ideas from across the field,
  tested and assembled, set up with sane defaults — that's what installs when you run the command.
- **Open all the way down.** Open-source code on open-source models. The open models — DeepSeek, Kimi,
  GLM — are genuinely good now: you pick one by name, your key, no markup, no closed vendor moving the
  price under you.
- **One command, and it works.** Telegram for the chat, Deepgram for voice, a tree-shaped memory,
  nightly rollups — already picked, wired and configured. The Linux Mint of AI agents.

Lots of agents out there. This one's mine — now it's yours too.

---

## What it can do

| | |
|---|---|
| 🎙️ **Voice & video** | Transcribes voice notes and video circles, understands speech in many languages (Deepgram nova-3). |
| 🧠 **Long-term memory** | Remembers your conversations and tidies them up on its own, every night. |
| 🔎 **Fast recall** | Finds the right note in seconds with a local FTS index over plain Markdown files. |
| ⏰ **On a schedule** | Day or week digests, recurring jobs. Can check your inbox and send you a summary, on time. |
| 🔔 **Reminders** | Tell it what and when, and it won't let you forget. |
| 🤖 **Your choice of model** | DeepSeek, Kimi, GLM and other open models — switch any time. |
| 🌐 **Does more** | Searches the web (free Tavily/Exa key), opens pages, drives a browser, connects to MCP servers. |
| 🎭 **A character** | Change its tone and rules right in the chat — it rewrites itself. |

Everything the best agents have — voice, search, skills, MCP — Iva has too. The difference is what
happens underneath.

---

## Memory — the part that compounds

Most agents forget you the moment the context window fills up. Iva doesn't. Its memory is shaped like
a tree — and the name *Iva* means *willow* in Russian.

```
        🪵  TRUNK   — year + cards on people, projects, decisions (the durable picture)
       ╱  ╲
      🌿 BRANCHES   — monthly summaries, built from weeks, built from days
     ╱      ╲
    🍃 LEAVES        — the full, word-for-word transcript of each day
```

- **Leaves** — every day's raw transcript, kept verbatim.
- **Branches** — short summaries: first per day, then a week folded from days, a month from weeks.
- **Trunk** — it all converges into the big picture: the year, plus fact cards on the people,
  projects and decisions that matter.

Every night Iva does the gardening itself: it summarizes the leaves and folds them up the branches.
So it can recall word-for-word what was said on a specific Tuesday *and* tell you what you spent the
whole month on.

**It's "low-context memory" by design.** Iva never loads its whole history into the model. Always in
context is one tiny CORE file (who you are, your standing preferences, active goals); everything else
is pulled in only when a task needs it, found by a local lexical FTS5 index over the files.

The heavy memory systems — [Papr](https://platform.papr.ai), mem0, MemGPT/Letta — buy semantic recall
with an embedding model plus a vector or graph database to run, sync and pay for. Iva spends its
complexity budget at the other end: it **structures memory when it's written** (the nightly rollup and
the entity cards) so reading it can stay a local lexical search. The trade is honest — this wins on
local-first, zero-infrastructure, fully inspectable, git-diffable memory for a personal vault. SQLite FTS5
is a local, rebuildable sidecar; if you ever outgrow lexical recall, embeddings are an upgrade path, not a rewrite.

What that buys you:

- **Zero extra infrastructure** — no vector DB, embedding model or graph server. Memory is Markdown files;
  the local FTS index is derived and rebuildable.
- **Fully yours and readable** — open any memory in a text editor, grep it, diff it in git.
- **Cheap and private** — lives on your disk, nothing shipped to a third-party memory service.
- **Easy to fix** — when memory is wrong, you edit a file. The local index refreshes from changed files;
  there are no stale embeddings to chase.

Memory is the part I've worked on the longest — first
[agent-second-brain](https://github.com/smixs/agent-second-brain), then the **autograph** typed-graph
skill, and all of it folded into Iva. The tree above is a hierarchical summary DAG: it compacts older
days while keeping a pointer back to every original — the idea at the heart of the
**[LCM: Lossless Context Management](https://papers.voltropy.com/LCM)** paper (Ehrlich & Blackman,
2026), plus my own vision and a lot of practice on top. It's one of the best memory designs you'll find
in a personal agent today — and it runs on open models you own, no subscription required.

---

## How it works

```
Telegram  ──(long-polling, getUpdates)──►  Iva (eve agent on your host)  ──►  vault (Markdown files)
                                                                              ▲
                                          systemd timers ─ nightly rollups ───┘
```

No public domain, no webhook, no reverse proxy. Iva polls Telegram from inside, so it runs on any
plain server. At night, systemd timers roll the day's transcript up into summaries and back up the
vault to a private git repo.

---

## Providers & cost

Iva is free and open-source. You pay only for a server and whichever model service you choose:

- **Server** — any small always-on box (a VPS with ~1–2 GB RAM, around **$5/mo**), or your own
  computer if you keep it on.
- **Model** — pick one provider, both OpenAI-compatible, with your own key:
  - **[OpenCode Zen](https://opencode.ai/zen)** — pay as you go. Its initial balance, model prices and
    payment-processing fee change over time; set a monthly spend limit in Zen.
  - **[Ollama Cloud](https://ollama.com/pricing)** — a free tier is available; Pro is **$20/mo** and
    includes more cloud usage.

  Inside either, you choose the model (DeepSeek recommended). Check the provider's current model list,
  availability and price before subscribing.
- **Voice** — [Deepgram](https://console.deepgram.com) for transcription (free starter credit).

---

## Install

1. Open a terminal on your server (or your own computer).
2. Paste the command and hit Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/mamysh/iva/codex/iva-prod/install.sh | bash
   ```
3. The installer asks your language first (English or Russian), then walks you through each key with a
   direct link — paste them when prompted. Once it asks, send your bot any message so Iva learns who
   you are and answers only you.
4. Done. Message your bot in Telegram — Iva replies.

More on running it on a VPS: [DEPLOY.md](DEPLOY.md).

---

## Talking to Iva

Message the bot like a normal chat — text or voice. Commands work right in the chat:

| Command | What it does |
|---------|--------------|
| `/task buy milk` | add a task |
| `/tasks` | show the task list |
| `/reminders` | show active reminders |
| `/digest` | day summary |
| `/new` | start the conversation fresh |
| `/help` | list of commands |
| `/restart` | restart if it ever hangs |

---

## Privacy

The code and the memory stay on your server. The vault is its own **private** git repo — set the
remote once and your memory backs itself up. Keys live in `.env`, never in the code, and the bot
answers only the Telegram IDs you allow (it stays silent to everyone else by default).

Honest about the boundary: the **model** and **voice transcription** run through cloud APIs (the ones
you picked and pay for). Self-hosted means your code and memory — not the model weights.

---

## What Iva does *not* do

So you know exactly what you're getting:

- **Telegram only.** No web app or dashboard — the chat is the whole interface.
- **Replies in the language you chose at install.** Switchable, but it's one language at a time.
- **Memory backup is a `git push`** to a repo you create once — not a managed cloud sync.
- **Search is lexical, not semantic.** It uses a local SQLite FTS5 index over your files; there's no
  vector/embedding recall.
- **Single user.** One owner, one vault — not a team or multi-tenant assistant.
- **Pre-1.0.** It works and it's in daily use, but it's young. Expect rough edges, report them.

---

## Star it

If Iva is useful to you, a ⭐ genuinely helps other people find it — that's the whole marketing budget.

[![Star History Chart](https://api.star-history.com/svg?repos=smixs/iva&type=Date)](https://star-history.com/#smixs/iva&Date)

---

## Built on

[eve](https://www.npmjs.com/package/eve) (the agent framework), autograph (the typed-graph memory
skill), and the ideas from [agent-second-brain](https://github.com/smixs/agent-second-brain).

## License

[MIT](LICENSE) — take the code and do what you want with it. Change it, run it on a hundred servers,
use it in your own projects. One condition: don't blame anyone if something breaks. It's yours now.
