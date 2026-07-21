# Command reference

Iva has two control surfaces: slash commands in Telegram and the `iva` command on your server. This page is all of them.

## Telegram commands

| Command | What it does |
|---|---|
| `/help` | This list |
| `/task <text>` | Add a task; without text, Iva asks what to add |
| `/tasks` | Show the task list |
| `/reminders` | Show active reminders without calling the model |
| `/digest` | Morning digest built by the morning-digest skill |
| `/new` | Cancel active workflow sessions and start a new conversation |
| `/restart` | Restart only the agent process; durable workflow state is preserved |
| `/clear` `/compact` | Same reset as `/new` |
| `/update` | Check for a new version; if there is one, tap **Update** to install it |
| `/model` | Show and independently change the text and vision provider/model using owner-only buttons |
| `/think` | Change text reasoning depth when the active provider supports it (currently Codex) |
| `/usage [window]` | Token spend — variants below |

Two kinds here. `/task`, `/tasks` and `/digest` route into the agent and need it running. `/help`, `/usage`, `/reminders`, `/restart`, `/new`, `/clear`, `/compact`, `/update`, `/model` and `/think` never reach the agent — the long-poll bridge handles them itself, out-of-band. `/restart` restarts only `iva.service`; `/new`, `/clear` and `/compact` explicitly cancel active workflow sessions through the same backend-neutral reset used by the server CLI. Neither operation deletes workflow storage, terminal history, the vault, tasks or reminders. The bridge only obeys user IDs on the allowlist.

`/model` lists only providers whose key or Codex OAuth is already configured. Telegram never accepts a
new credential or arbitrary model ID. Text and vision are separate roles: changing text preserves the
active vision route. Before applying a model, Iva runs a bounded synthetic capability probe, writes
only allowlisted model keys to `.env`, restarts `iva.service`, waits for stable readiness, and restores
the exact previous configuration if readiness fails. Picker callbacks are opaque, owner/chat-bound and
expire after five minutes.

`/update` compares your install with its explicit private update channel. The first release allows only
`origin/main`; a temporary checkout cannot silently change it, and `upstream/main` is never a production
channel. Legacy installs are pinned only when their factual tracking branch is already `origin/main`.
If a newer version exists, Iva replies with the version bump and two buttons — **⬆️ Update** and
**Skip**. Update pulls the reviewed fork branch, rebuilds and restarts Iva in its own detached scope
(so the restart of the bridge can't kill the update mid-flight), then reports ✅ or ❌ back in the
chat. Nothing happens until you tap. Changes from the source `smixs/iva` repository are integrated
into this deployment repository separately before they can reach production.

### /usage variants

| Variant | Window |
|---|---|
| `/usage` or `/usage last` | The last turn: tokens, steps, model, source |
| `/usage today` | Current day in your timezone |
| `/usage week` | Last 7 days |
| `/usage month` | Current calendar month |
| `/usage by-model` | Lifetime totals per model |
| `/usage by-source` | Lifetime, chat vs background (rollups, digest) |

`/usage` costs zero tokens — the bridge reads the log, no model call.

## Server CLI

The installer puts `iva` in `~/.local/bin`. Commands that touch systemd need a Linux server.

| Command | What it does |
|---|---|
| `iva update [--force]` | Transactional update protected by a shared CLI/Telegram lock: preflight, detached dependency install/tests/typecheck/build/profile canary, required migration backup, atomic activation, restart and doctor readiness. A failed build leaves the active version untouched; failed readiness automatically restores the previous commit/output/dependencies. `--force` repeats the transaction at the current commit |
| `iva backup [directory]` | Briefly stop every writer, create a private portable directory outside the code repository, snapshot the active local/PostgreSQL Workflow backend, checksum every file, verify it, then restore the previously active units |
| `iva restore <directory> [--yes]` | Verify and restore configuration, vault, app data and Workflow state on an installed host, rebuild and check capabilities. Destructive confirmation is required; services remain stopped to prevent duplicate Telegram polling during a move |
| `iva config` | The 5-step setup wizard, then offers a restart to apply |
| `iva login [--browser]` | Sign in to an OpenAI (ChatGPT) subscription for `MODEL_PROVIDER=codex`. Default is device code (a link + one-time code, works on a headless VPS); `--browser` runs the local PKCE flow. Token → `data/codex-auth.json` (chmod 600) |
| `iva doctor [--json]` | Layered health check for configuration, build/profile, services, Workflow storage, Telegram, provider, memory, backups and capacity. The human command applies only safe service/build repairs; `--json` returns a sanitized support/CI report without auto-repair |
| `iva status` | Explicit sanitized update channel plus a concise hourly baseline: service RSS/restarts, Workflow size/growth and queue, oldest active run, recent successful jobs/backup, disk/inodes and swap |
| `iva restart` | Process lifecycle only: regenerate units and restart agent + bridge without changing durable workflow state |
| `iva recover` | Stop the agent, repair interrupted steps, abandon only interrupted child turns, restart and re-enqueue durable work; refuses to mutate state when storage is unavailable |
| `iva reset` | With confirmation, cancel every active workflow session and restart the agent; preserve terminal history, storage, vault, tasks and reminders |
| `iva workflow-smoke seed\|resume` | Verify that an interactive workflow session survives a service restart |
| `iva workflow-postgres enable` | Advanced, idempotent PostgreSQL install/profile/bootstrap/readiness operation for Ubuntu 22.04+ and Debian 12+; includes two small model smoke turns |
| `iva reminders` | Show active reminders from `data/reminders.json` |
| `iva usage [window]` | Same windows as `/usage`, plus `tail [N]` — the last N raw log lines (default 10) |
| `iva start` / `iva stop` | Start both services and enable at boot / stop them |
| `iva logs [poll\|reminders]` | Follow agent logs, last 50 lines; `poll` follows the Telegram bridge, `reminders` follows reminder delivery |
| `iva uninstall [--purge]` | Remove units and the `iva` command; `--purge` also deletes code and vault, after a second confirmation |
| `iva version` | Package version + git commit |
| `iva tree` | The willow, animated |

```bash
iva usage week      # 7-day totals, by source and model
iva usage tail 20   # last 20 raw log lines
iva reminders       # active reminders
```

`iva reset --yes` skips the interactive confirmation for an already authorized automation. There is intentionally no workflow `purge` command: destructive deletion requires a verified backup/restore design first.

`iva doctor` reports `healthy`, `degraded`, or `blocked`. Exit code `1` means at least one failure blocks replies; warnings and non-blocking failures produce `degraded` with exit code `0`. Each failing check includes one action to take. `iva doctor --json` uses schema version `1` and excludes credentials, database URLs, user/chat IDs, private paths and memory contents, so its output can be attached to a support request. The nightly `npm run doctor` command is a separate memory-maintenance job; it is not the installation/runtime diagnostic.

Update prints one final state: `UPDATED` or `ROLLED BACK`. Migration manifests support only the current migration version or one sequential N−1 → N hop. A migration command cannot run unless its failure strategy and verified Workflow backup are declared. Optional global CLIs are outside this critical transaction and may be refreshed separately.

Portable backup and restore semantics, including the honest vault-only boundary, file modes,
PostgreSQL client compatibility and clean-host move procedure, are documented in
[Data, backup, restore, and server moves](data-and-backup.md).

The status baseline and alert policy are documented in [Health metrics and capacity](observability.md).

Reminder delivery is claimed durably before Telegram is called. A definite Telegram rejection may retry. If the process or network fails after the call begins, the reminder becomes `delivery_unknown` and is not automatically resent, because Telegram's Bot API provides no idempotency key and a blind retry could deliver a duplicate.

## Token accounting

Every model step appends one JSON line to `data/usage.jsonl` — including tool-call rounds, which is where most tokens actually go. What each line carries:

- 📍 **Source** — `telegram` chat vs `http` background jobs, so rollups and digests don't hide inside your chat totals
- 🧮 **Five counters** — in, out, cache read, cache write, total — plus model, session, turn and step index
- 🤖 **Subagent steps** — planner tokens are tagged with the subagent name and counted, not lost

The log lives in `data/` next to `tasks.json` and `reminders.json`, gitignored and outside the vault — otherwise the nightly doctor would commit an ever-growing log into your memory repo.

No dollar figures, on purpose. Both providers are flat-rate subscriptions (see [providers.md](providers.md)), so there is no per-token price to multiply. Tokens are the number you can trust; a computed dollar estimate would be fiction.
