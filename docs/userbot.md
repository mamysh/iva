# Telegram userbot (beta, opt-in)

> 🧪 **Beta — expect bugs.** This feature is new and still rough: onboarding steps or tool
> calls can misbehave. Set it up **at your own risk** and don't lean on it for anything
> critical yet. Feedback and issues welcome.

Iva can optionally access a **personal Telegram account** (a userbot), not just the
ordinary bot. It talks to a small proxy — `services/telegram-userbot/serve.py` — that owns
one Telethon session and exposes Telegram over MCP on `127.0.0.1`. Iva connects to it
natively (`agent/connections/telegram-userbot.ts`). The feature is disabled by default;
its default surface is read-only.

> ⚠️ **Account-ban risk.** Automating a personal account violates Telegram's ToS and can
> get the account **banned** — especially for sending. Reading is far safer.
>
> A **built-in anti-ban guardrail is enforced server-side** (`guardrails.py`) for the
> permitted send methods — not just
> advice: FloodWait compliance (wait ×1.3, retry once), a randomized delay after every send
> (fixed-interval bots get flagged), and a circuit-breaker that pauses sending after 3
> FloodWaits in 24h; its state survives proxy restarts. The default MCP surface is read-only.
> Enabling the full upstream mutation surface requires a separate security review. Limits are still per-account, so
> behave like a human. Full rules: `agent/skills/telegram-userbot/safety.md`.

## Tool surface

The pinned upstream package registers 116 tools. Iva's default `read-only` mode prunes
67 mutation tools, leaving 49 upstream read-only tools; four local onboarding tools are
then added, for 53 exposed tools total. `TELEGRAM_EXPOSED_TOOLS=all` exposes all 116
upstream tools plus onboarding and is intentionally not a supported default.

## Connect

Use a dedicated test account first. The safer setup path keeps the Telegram application
credentials out of the model conversation:

```bash
iva userbot creds
iva userbot setup
```

Then tell the bot **«подключи мой телеграм»** to request and deliver the QR:

1. It warns you (at your own risk) and, the first time, walks you through creating an app at
   <https://my.telegram.org> → **API development tools**. If credentials are not configured,
   chat onboarding can collect `api_id` / `api_hash` and provision the proxy, but those values
   then transit the agent conversation. Prefer `iva userbot creds` on the server.
2. It renders a QR and sends it as an image into your chat. Scan it in the Telegram app of the
   account you're connecting: **Settings → Devices → Link Desktop Device**.
3. If the account has 2FA, chat onboarding must receive that password to finish login. Do not
   reuse that password elsewhere; rotate it afterward and remember that model/provider logging
   may retain conversation content. Done — the session persists on the server, so login is one-time.

## Manual commands

```bash
iva userbot creds    # read api_id + api_hash from stdin → .env (two lines)
iva userbot setup    # build venv, generate the token, enable + start the proxy (idempotent)
iva userbot status   # service running? venv built? token present?
iva userbot off      # stop and disable the proxy
```

## Safety knobs

- `TELEGRAM_EXPOSED_TOOLS=read-only` is the default — the agent can read/search through 49
  upstream tools but cannot send or mutate through MCP. Four onboarding tools remain available.
  Setting `all` is an explicit high-risk opt-in and is not a supported default.
- `TELEGRAM_MCP_PORT` (default `8724`), `TELEGRAM_USERBOT_QR_CHAT_ID` (defaults to the first
  of `TELEGRAM_ALLOWED_USER_IDS`). The default needs no config. If you set a custom port,
  run `iva userbot setup` (restarts the proxy) **and** `iva restart` (iva reads the port from
  its env at start) so both agree.
- The proxy bearer lives in `data/telegram-userbot.token` (0600), read at runtime by both the
  proxy and iva — so the agent can provision the proxy mid-chat without restarting iva.

## How it works

- **One session owner.** Exactly one process may own a Telethon session; a second opener
  desyncs MTProto. The proxy is that owner; iva calls it over HTTP.
- **Session-less boot.** With no session yet, the proxy comes up unauthorized (onboarding
  mode) and serves only login tools until you scan the QR — then the same live client
  becomes authorized in place, no restart.
- **Enforced anti-ban.** `guardrails.py` wraps the outbound methods (`send_message`,
  `send_file`, `forward_messages`) with FloodWait compliance, randomized pacing, and a
  circuit-breaker (3 FloodWaits in 24h → sending pauses).
- Built on [chigwell/telegram-mcp](https://github.com/chigwell/telegram-mcp) release `v3.2.0`
  (116 upstream tools), pinned to audited commit `f1a2d8e00a7f127bb7702655c58fdfcee7e73a5a`
  in `services/telegram-userbot/requirements.txt`.
