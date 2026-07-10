# Production architecture

This is the architecture of the final `main` branch. It combines Iva v0.2.4 with the self-host
hardening needed by the running single-user VPS; it is not a PR handoff or a list of unmerged ideas.

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

- Providers: Ollama Cloud, OpenCode Zen, OpenRouter, or an OpenAI ChatGPT subscription through Codex OAuth.
- Voice: Deepgram transcription; vision uses the selected provider's compatible vision path.
- Web search: the selected API provider with a graceful DuckDuckGo fallback.
- Google Workspace: the optional `gws` CLI skill, configured only when the owner explicitly connects it.
- Telegram MCP is **not** part of this branch. Do not describe it as a supported product capability until it has a separate security-reviewed integration.

## Portable defaults vs the running production profile

Default installs remain file-backed and need no database. PostgreSQL is opt-in through:

```dotenv
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
WORKFLOW_POSTGRES_URL=postgresql:///iva_workflow?host=/var/run/postgresql
```

The running production VPS uses this PostgreSQL profile. It keeps app workflow state in `iva_workflow`;
the live vault remains at `ASSISTANT_VAULT_DIR` and is never migrated into the app database.

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

## Current production follow-up

When updating an existing vault, migrate the bundled Autograph template as well as the app. The production
vault must contain `supersede.py`; without it, `iva-memory-doctor` completes backup work but reports a
failed maintenance run. Verify the next doctor run after any vault-template migration.

For command-level operations see [deploy.md](deploy.md), [cli.md](cli.md), and
[troubleshooting.md](troubleshooting.md).
