# Deploy

The default self-host profile runs on one VPS as two systemd user services and seven timers. `install.sh`
sets them up ([install](./install.md)); the optional userbot adds a third service only when explicitly enabled.

## Transport: long polling

Telegram never connects to your server. `scripts/telegram-poll.mjs` long-polls `getUpdates` and POSTs each update to the local eve webhook (`http://127.0.0.1:8723/eve/v1/telegram`) with the shared `X-Telegram-Bot-Api-Secret-Token` header. Telegram sees an ordinary bot; the channel code is unchanged. No public HTTPS, no domain, no reverse proxy.

The bridge also gives you:

- 📬 **Ordered delivery** — advances the offset (`data/telegram-offset.json`) only after eve replies 2xx, retrying with backoff up to 15s while the server boots.
- ⏱ **Per-chat pacing** — a 1.5s pause between updates to the same chat, so a burst can't start two runs on one session.
- 🛟 **Out-of-band recovery** — a handful of slash commands (`/restart` and friends) are handled by the bridge itself, so they work even when the agent is stuck. Which ones, and what they do: [cli.md](./cli.md).

### Webhook mode (alternative)

Polling and webhook are mutually exclusive — the bridge calls `deleteWebhook` on start. If you do have a public HTTPS endpoint, disable the bridge and register the webhook:

```bash
systemctl --user disable --now iva-telegram-poll
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-domain>/eve/v1/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET_TOKEN"'",
       "allowed_updates":["message","callback_query"]}'
```

Note: `getUpdates` — which the setup wizard uses to discover your user ID — stops working while a webhook is registered.

## systemd units

`bin/iva.mjs` is the single source of truth for every unit. Any restart through the `iva` CLI regenerates them first, so `Environment=PORT` always matches `IVA_PORT` in `.env`. Don't hand-edit `~/.config/systemd/user/iva-*` — edits get overwritten. If you write your own unit instead, bake the port literally (`Environment=PORT=8723`): systemd will not expand `$IVA_PORT` from an `EnvironmentFile`.

| Unit | When | Job |
|------|------|-----|
| `iva.service` | always | the agent (`eve start`), `Restart=always` |
| `iva-telegram-poll.service` | always | the long-polling bridge |
| `iva-telegram-userbot.service` | opt-in (`iva userbot setup`) | Telethon userbot MCP proxy — see [userbot.md](userbot.md) |
| `iva-memory-daily.timer` | 04:00 nightly | transcript → cards + daily summary, report to Telegram |
| `iva-memory-weekly.timer` | Sun 04:15 | 7 dailies → weekly summary, report to Telegram |
| `iva-memory-monthly.timer` | 1st, 04:20 | weeklies → monthly summary (silent) |
| `iva-memory-yearly.timer` | Jan 1, 04:25 | monthlies → yearly summary (silent) |
| `iva-memory-doctor.timer` | 05:00 nightly | schema/health/decay/MOC checks + vault `git push` |
| `iva-reminders.timer` | every 5 minutes | short-lived reminder dispatcher; sends due reminders without calling the workflow |
| `iva-observe.timer` | hourly | bounded health/capacity counters and deduplicated actionable alerts |

Timers fire in the server's **local time** and carry `Persistent=true`, so a run missed during downtime fires after reboot. Set the server clock to match your `.env`:

```bash
sudo timedatectl set-timezone "$ASSISTANT_TIMEZONE"
```

Manual runs and status:

```bash
npm run memory -- daily   # or weekly | monthly | yearly
npm run doctor            # nightly memory maintenance/backup job
iva doctor                # installation and runtime diagnostics
systemctl --user list-timers
iva logs                  # agent; `iva logs poll` for the bridge
```

Full CLI reference: [cli](./cli.md). What the rollups actually write: [memory](./memory.md).

Updates are transactional. `iva update` stages a detached checkout under ignored `.iva-update/`, runs
the locked dependency install and all pre-activation gates there, then switches the build and
dependencies only for the restart. A broken target build never touches the active output. Failed
doctor readiness automatically restores the previous commit/output/dependencies. Optional global
tools such as `gws` are deliberately outside this critical transaction.

One thing that trips people up: eve has a `defineSchedule` API, but on self-host it never fires — it only becomes a cron job on Vercel. That is the whole reason memory runs on systemd timers.

## Workflow backend

Default installs use eve's local file-backed workflow state in `.workflow-data`. That is the lightest setup and needs no database. Long-running self-host installs can opt into the official PostgreSQL Workflow World instead:

```bash
iva workflow-postgres enable
```

This is an explicit advanced operation; PostgreSQL is not another question in the normal setup wizard.
It supports Ubuntu 22.04+ and Debian 12+, requires at least 1 GiB combined RAM/swap and 1 GiB free
disk, and asks for sudo only for OS/PostgreSQL administration. The command:

1. installs PostgreSQL packages when absent and discovers the actual cluster, version and active
   config path;
2. installs the conservative small-server tuning beside that active config without assuming a
   versioned `/etc` path;
3. creates a peer-auth role matching the Unix user that owns `iva.service`, plus the `iva_workflow`
   database, idempotently;
4. writes the ignored profile environment with mode `0600`, runs the official pinned-package
   bootstrap and verifies the Workflow, Drizzle migration and Graphile Worker schemas;
5. builds the PostgreSQL profile, starts Iva, and runs a two-message seed/restart/resume smoke test.

The smoke uses the configured model provider, so it consumes two small model turns. It does not write
facts to the vault or create tasks/reminders. Re-running the command preserves the schema and all
existing runs. On failure the database is never deleted. The previous local profile is restored only
when the PostgreSQL run table is still empty; once a PostgreSQL session exists, the command fails
closed and leaves the durable state intact for diagnosis.

The generated `iva.service` loads `deploy/iva-workflow.environment` if it exists, then `.env`; the later `.env` value wins. Keep secrets in `.env` if your database URL contains a password. The build wrapper resolves the selector with the same precedence and records a sanitized profile descriptor in `.output`. Startup fails before accepting messages when that descriptor differs from runtime.

The enable operation already runs this restart/resume acceptance check. To repeat only that check:

```bash
iva workflow-smoke seed
iva restart
iva workflow-smoke resume
```

Lifecycle commands have identical semantics on both workflow backends. `iva restart` changes only processes. `iva recover` repairs and re-enqueues interrupted work without deleting durable state. `iva reset`, after confirmation, cancels active sessions but preserves terminal history and storage. There is no automatic workflow purge.

The generated variables match Workflow's official Postgres world naming: `WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and `WORKFLOW_POSTGRES_URL`. The old `IVA_WORKFLOW_WORLD` alias and the `postgres` shorthand are rejected so build, service, doctor, reset and update cannot interpret the same installation differently. `deploy/iva-workflow-postgres.environment.example` remains a reference for externally managed PostgreSQL; the supported self-host path is the command above.

## nginx and TLS

You need neither for Telegram — polling is outbound-only. Add an nginx reverse proxy with Let's Encrypt only if you expose the eve HTTP channel (or webhook mode) to the internet.

## Moving servers

Use `iva backup`, copy the verified private directory off the old host, install Iva on the new host,
and run `iva restore <directory> --yes`. Restore leaves services stopped: stop the old host before
`iva start` on the new one, so two processes never poll the same Telegram bot. The complete inventory,
PostgreSQL requirements, modes and failure procedure are in [Data, backup, restore, and server
moves](data-and-backup.md).

If all you have is the vault repo, memory survives, but tasks, reminders, OAuth, userbot authorization
and Workflow sessions do not.

## Vercel (advanced)

Iva is built on eve, which deploys to Vercel natively — but self-host is the intended path. If you go there anyway:

- **Schedules** — `defineSchedule` in `agent/schedules/*.ts` becomes a real Vercel Cron Job (cron times are UTC there).
- **Storage** — `./data` is ephemeral on Vercel; tasks, reminders and usage logs need a real DB or KV store.
- **Auth** — the scaffold eve channel ships `localDev()` + `placeholderAuth()`. In prod, `localDev` is ignored and `placeholderAuth` admits nobody. Wire a real auth provider, or for a single-user deployment issue a bearer token and pass it to your scripts as `ASSISTANT_BEARER`.
