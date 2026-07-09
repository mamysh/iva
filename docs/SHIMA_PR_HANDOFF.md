# PR handoff: production hardening for self-hosted Iva

This branch is intentionally scoped as production hardening on top of upstream Iva, not as a fork-specific rewrite.

## Motivation

Long-running self-hosted Iva instances can accumulate local workflow state in `.workflow-data`. On a small VPS this can make restarts re-enqueue wedged runs and keep CPU high. The vault is not the problem: memory stays in markdown. The fragile piece is workflow execution state.

The branch keeps upstream's provider/memory/security work as the base and adds opt-in operational pieces from a real self-host deployment.

## What changed

- Optional PostgreSQL Workflow backend:
  - `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`
  - `@workflow/world-postgres@5.0.0-beta.23`
  - `eve@0.11.10`, the first locally validated Eve line with `experimental.workflow.world`
  - conservative PostgreSQL profile for a 1 vCPU / 1 GiB VPS
  - `iva workflow-smoke seed|resume` restart/resume validation
- Safer service lifecycle:
  - optional `deploy/iva-workflow.environment`
  - `RestartSec=2s`, `TimeoutStopSec=15s`, `SendSIGKILL=yes`
  - `iva reset` no longer pretends it can wipe durable PostgreSQL state
- Durable reminders:
  - model tool `reminders`
  - `data/reminders.json`
  - short-lived `iva-reminders.timer` dispatcher every 5 minutes
  - `/reminders` and `iva reminders` read active reminders without a model call
- Tests:
  - workflow backend env normalization
  - reminders timezone/repeat/failure/load-save behavior

## Compatibility

Default installs remain file-backed and require no database. PostgreSQL is opt-in via env. The live vault remains separate (`ASSISTANT_VAULT_DIR`) and is not migrated into the app repo or database.

Telegram MCP is intentionally not included in this branch. It should be designed separately with a tighter security review.

## Manual validation before merge

```bash
npm ci
npm test
npm run typecheck
npm run build

cp deploy/iva-workflow-postgres.environment.example deploy/iva-workflow.environment
iva restart
iva workflow-smoke seed
iva restart
iva workflow-smoke resume
iva reminders
```

The workflow env variable names match the Workflow SDK Postgres World docs:
`WORKFLOW_TARGET_WORLD=@workflow/world-postgres` and `WORKFLOW_POSTGRES_URL`.
