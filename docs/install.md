# Install

Everything between `curl` and a working bot. One command on a fresh server: the installer asks your
language, walks you through five keys, and finishes only after Eve and the Telegram bridge pass the
readiness gate.

## Requirements

- 🖥️ **A supported server** — the stable release matrix targets Ubuntu 24.04 LTS on Linux x64. Other systems may work but are not yet release-qualified.
- 🧠 **512MB RAM is enough** — on boxes under 1.5GB the installer adds a 2GB swapfile so the build isn't OOM-killed (needs ~2.6GB free disk).
- 🔑 **sudo** — asked up front, and only if system packages are missing or a swapfile is needed; the Chromium step may ask once more.

> Never used a server? The host sends you an address (IP), a login and a password. On Mac or Linux open Terminal, on Windows PowerShell, type `ssh root@YOUR_ADDRESS`, enter the password. You're in.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/mamysh/iva/v0.3.0-rc.7/install.sh | BRANCH=v0.3.0-rc.7 bash
```

This installs the exact RC7 candidate tag. Its release evidence is still being collected. General users should wait for the stable-channel command in the
`v0.3.0` release notes; `main` is a moving development channel.

The first question is your language — English or Russian — before anything touches the system. Input is read from `/dev/tty`, so the wizard stays interactive even piped through `curl`. If there's no terminal at all (Docker, CI), setup is skipped and the script prints how to run it later.

## Setup wizard

Five steps. Each key comes with a direct link to where it lives, and each is validated live — a bad key is rejected on the spot, not discovered at runtime. Enter keeps the current value, so re-running the wizard (`iva config`) changes only what you want.

1. **Provider and model.** Ollama Cloud, OpenCode Zen, OpenRouter or a ChatGPT subscription ([comparison](providers.md)); access is checked live before setup continues.
2. **Voice, search, hybrid memory.** Deepgram key (free starter credit); recognition language `multi` auto-detects ru/uz/en. The same step picks a web-search provider — Tavily, Exa, Parallel or Brave; Enter skips and search stays off — and offers optional hybrid memory with an embedding key.
3. **Telegram bot.** Paste the token from @BotFather; the wizard validates it via `getMe` and detects the bot's username itself.
4. **Access.** Send your new bot any message — "hi" works. The wizard reads `getUpdates`, shows who wrote, and you pick yourself. Iva answers only these IDs; an empty list means it answers nobody.
5. **Timezone, vault, port.** IANA timezone so nightly jobs run on your clock, the vault directory, and the port — default 8723, probed for conflicts.

## What install.sh does

- 📦 **System packages** — `git gh python3 ffmpeg pandoc poppler-utils` (`poppler` on brew): `gh` backs your vault up to a private GitHub repo, pandoc and poppler extract text from incoming docx/pdf files, ffmpeg converts media the transcriber can't take directly.
- 🐍 **uv** — runs the vault's Python maintenance scripts.
- 🟢 **Node 24 via nvm** — no root needed; 24 is a hard floor because memory search uses the built-in `node:sqlite`.
- 🌐 **agent-browser + Chromium** — headless browser for web tasks; the longest step, 1–3 minutes of visible download output.
- 🗂️ **Vault init** — your memory is created from `vault-template/` as a separate git repo, so personal data never enters the code repo.
- ⚙️ **systemd user units** — the agent, Telegram bridge, five memory timers, reminder dispatcher and bounded observability collector, with linger enabled so they survive logout. Details: [deploy.md](deploy.md).
- 🧰 **The `iva` command** — installed into `~/.local/bin`: `iva status`, `iva doctor`, `iva update`. Full reference: [cli.md](cli.md).
- ✅ **Readiness verification** — the installer checks Eve health twice, both services, restart counts
  and fresh startup journals. A direct Telegram API request is not treated as proof that Iva works.
- 🧾 **Install report** — a private `0600` JSONL report under `~/.local/state/iva/` records completed,
  pending and failed stages plus the generic resume command; it contains no credentials or logs.

Re-running the same command later is safe: it reuses the existing checkout, fast-forwards it, and keeps `.env` and the vault untouched.

### Flags and overrides

Flags pass through the pipe with `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/mamysh/iva/v0.3.0-rc.7/install.sh | BRANCH=v0.3.0-rc.7 bash -s -- --skip-setup
```

| Option | Effect |
|---|---|
| `--skip-setup` | install everything, don't run the wizard |
| `--non-interactive` | no questions at all — defaults only, wizard skipped |
| `-h`, `--help` | show the built-in help and exit |
| `REPO_URL=…` | install from a fork (default `https://github.com/mamysh/iva.git`) |
| `BRANCH=…` | install a branch or tag (`v0.3.0-rc.7` for the current candidate) |
| `INSTALL_DIR=…` | where the code goes (default `~/iva`) |

The last three are environment variables, read by the script at startup.

## If the wizard didn't run

Skipped setup, or no terminal at install time:

```bash
cd ~/iva && npm run setup
```

The first run reports `Runtime installed, configuration pending`; it does not claim the bot is ready.
Then re-run the install command above — it finds the existing checkout and finishes the build, units
and readiness verification.

## Next steps

- Every `.env` variable, defaults and warnings — [configuration.md](configuration.md)
- The `iva` server CLI and Telegram commands — [cli.md](cli.md)
- Transport, timers, webhook mode and operations — [deploy.md](deploy.md)
- Installer stages and false-success cases — [install-testing.md](install-testing.md)
