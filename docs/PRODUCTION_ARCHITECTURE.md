# Reference production architecture

This is the supported self-host architecture of the current `main` branch. It combines Iva v0.2.5
with production hardening for a long-running single-user VPS. Portable defaults remain lightweight;
PostgreSQL and the personal-account Telegram proxy are explicit opt-ins.

## Origin and upstream

The original Iva project was created by [Shima (`smixs`)](https://github.com/smixs) as [smixs/iva](https://github.com/smixs/iva). This fork retains that upstream as the source project and carries the self-host hardening and operations described below.

In the recommended remote layout, `origin` is your fork and the read-only `upstream` remote tracks
`smixs/iva`'s `main` branch. Do not develop directly on `upstream/main`.

To bring in an upstream release safely, create a short-lived integration branch from `main`, merge
`upstream/main` there, resolve conflicts, test, and review the diff in a pull request. Merge the reviewed
PR, deploy the resulting exact `main` commit, verify it, then delete the integration branch. This keeps
the steady-state layout to one production branch while preserving a reviewable integration point.

```bash
git fetch upstream
git switch -c update/upstream-YYYYMMDD main
git merge --no-ff upstream/main
npm ci && npm test && npm run typecheck && npm run build
# push the branch, review and merge its PR, then deploy the resulting main SHA
```

Git's recorded conflict resolutions (`rerere`) are enabled locally to make repeated upstream merges gentler. Before any integration, inspect `git log --oneline main..upstream/main` and keep local production changes where they intentionally differ.

## What this branch includes

| Layer | Implementation | Why it is here |
|---|---|---|
| Chat transport | Telegram long polling + allowlist | No public webhook or reverse proxy is required. |
| Agent runtime | Eve 0.11.10 | Model turns, tools and compaction. |
| Durable production state | PostgreSQL Workflow World | The production profile replaces the hot `.workflow-data` stream directory, so restarts retain durable workflow state without filesystem polling overhead. |
| Personal memory | Markdown vault in a separate private Git repository | Human-readable, portable source of truth, outside the app repository and outside PostgreSQL. |
| Memory recall | Node SQLite FTS5/BM25 + vault graph reranking | Local lexical recall with no search service. Optional hybrid mode adds embeddings only when explicitly configured. |
| Memory maintenance | systemd timers + Autograph | Daily/weekly/monthly/yearly rollups, card maintenance and vault backup. |
| Reminders | `data/reminders.json` + five-minute systemd dispatcher | Delivery does not depend on a live model turn or a homemade background process. |
| Security | Telegram allowlist, deterministic inbound sanitization, outbound secret redaction | External content is data, never authority; secrets are redacted before Telegram sends. |

## Model and integration stack

- Providers: Ollama Cloud, OpenCode Zen, OpenRouter, or an OpenAI ChatGPT subscription through Codex OAuth. Codex requests use stateless inline history (`store:false`), not backend-persisted response references.
- Voice: Deepgram transcription; vision uses the selected provider's compatible vision path.
- Web search: the selected API provider; if its key is missing, the assistant reports that search is unavailable instead of guessing.
- Google Workspace: the optional `gws` CLI skill, configured only when the owner explicitly connects it.
- Telegram userbot/MCP code is present as a **beta, opt-in** integration. It is disabled by default and
  its systemd unit is never included in the normal service set. Any evaluation should start on a test
  account in `TELEGRAM_EXPOSED_TOOLS=read-only` mode (49 upstream read-only tools plus four onboarding
  tools). Exposing the full mutation surface requires a separate security review.

## Portable defaults vs the PostgreSQL production profile

Default installs remain file-backed and need no database. PostgreSQL is opt-in through:

```dotenv
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
WORKFLOW_POSTGRES_URL=postgresql:///iva_workflow?host=/var/run/postgresql
```

With this profile, app workflow state lives in `iva_workflow`; the live vault remains at
`ASSISTANT_VAULT_DIR` and is never migrated into the app database.

The example environment and small-VPS PostgreSQL profile live in:

- [`deploy/iva-workflow-postgres.environment.example`](../deploy/iva-workflow-postgres.environment.example)
- [`deploy/postgresql-iva.conf`](../deploy/postgresql-iva.conf)

## Operational contract

Before deploying a runtime change:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

### VPS update runbook

Run operational commands as the dedicated service user from the directory where `install.sh`
cloned Iva. Do not put credentials in Git: `.env` and `deploy/iva-workflow.environment` stay
local, mode `0600`, and are already ignored.

Before an update, make local backups of those two files if present. The normal update is then:

```bash
cd /path/to/iva
iva update --force
iva doctor
iva status
```

`iva doctor` must report both `iva.service` and `iva-telegram-poll.service` active, six enabled
timers, the vault Git remote, and no failed checks. The polling bridge requires
`TELEGRAM_WEBHOOK_SECRET_TOKEN`; if it is absent from a legacy `.env`, create a new random secret
locally on the VPS before restarting the bridge. Never paste the value into a terminal transcript,
issue, or commit.

For a runtime release, prove durable workflow state survives restart:

```bash
iva workflow-smoke seed
iva restart
iva workflow-smoke resume
iva reminders
```

The successful expected smoke result is a seed reply `REMEMBERED`, then a resume reply containing
`CEDAR-4729`; `status=waiting` is normal for this interactive workflow. Finally, send the Telegram
bot `/help` (or a normal message) and inspect recent service logs if it does not reply:

```bash
journalctl --user -u iva -u iva-telegram-poll -n 100 --no-pager
```

For a PostgreSQL workflow migration or recovery check:

```bash
iva restart
iva workflow-smoke seed
iva restart
iva workflow-smoke resume
iva reminders
```

`iva reset` has deliberately different behavior by backend: it can clear local `.workflow-data`, but it
does **not** delete durable PostgreSQL workflow state. Clearing the database is a manual, deliberate
recovery operation.

## Existing vault upgrades

An app update does not overwrite a live vault because it is a separate private repository. When a release
changes `vault-template/.claude`, review and migrate those maintenance scripts into an existing vault,
then run `npm run doctor` and verify that the vault push succeeds. Keep a Git bundle backup before any
history repair or bulk migration.

For command-level operations see [deploy.md](deploy.md), [cli.md](cli.md), and
[troubleshooting.md](troubleshooting.md).
