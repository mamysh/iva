# Iva codebase map

This is the fast entry point for humans and coding agents working in this repository. It explains
where the important code lives, which files own each behavior, and what to inspect before changing a
subsystem. It intentionally links to detailed documentation instead of duplicating it.

This file is public. Never add machine-specific paths, hostnames, IP addresses, credentials, user
IDs, private operational notes or personal vault contents.

## Start here

Before editing:

```bash
git status --short --branch
npm test
npm run typecheck
```

After a normal code change:

```bash
npm test
npm run typecheck
npm run build
```

Public product and operations documentation starts at [`docs/README.md`](docs/README.md).

## Sources of truth

| Concern | Source of truth | Notes |
|---|---|---|
| Agent definition | `agent/agent.ts` | Model, context window, compaction and Workflow World selection. |
| Provider/model configuration | `agent/provider.ts` | Shared by the main agent and vision path. |
| Agent behavior | `agent/instructions.md` | Character, rules and tool-selection policy. |
| Runtime configuration | `.env` | Private and ignored. Generated/updated by `scripts/setup.mjs`. |
| Workflow profile contract | `scripts/lib/workflow-config.mjs` | Resolves local/PostgreSQL for agent, build, start and CLI. |
| Workflow profile override | `deploy/iva-workflow.environment` | Private, ignored, optional; loaded before `.env`. |
| CLI and generated systemd units | `bin/iva.mjs` | Do not hand-edit installed units; the CLI regenerates them. |
| Personal memory | live `ASSISTANT_VAULT_DIR` | Separate private Git repository; never part of the app repository. |
| Vault skeleton | `vault-template/` | Copied only when initializing an empty live vault. |
| Memory search index | live vault `.index/` | Derived and rebuildable, not a source of truth. |
| Tasks/reminders/usage | `ASSISTANT_DATA_DIR` (`data/` by default) | Private and ignored application data. |
| Data inventory and portable backup | `scripts/data-manifest.json` + `scripts/lib/portable-backup.mjs` | Sanitized catalog plus checksum/restore contract; operational writer control is in `scripts/backup-runtime.mjs`. |
| Extension contracts | `scripts/extension-contracts.json` + `scripts/lib/extension-contracts.mjs` | Static validation metadata, not a plugin loader; inert examples live in `examples/extensions/`. |
| Release contract | `scripts/release-contract.json` + `scripts/lib/release-contract.mjs` | Immutable tag identity, required matrix scenarios, supported platforms and soak thresholds. |
| Public docs | `docs/` | `docs/README.md` is the documentation index. |
| Dependency versions | `package.json` + `package-lock.json` | Keep runtime packages pinned where compatibility is sensitive. |

## Repository layout

```text
agent/                       Eve-authored agent: model, channels, tools, hooks, skills
  agent.ts                   Root agent configuration
  provider.ts                Provider/model selection and Codex integration
  vision.ts + lib/vision-provider.mjs
                             Image-description path shared by runtime and live release canary
  instructions.md            Main personality and behavioral contract
  instructions/              Dynamic language, memory map, CORE and current time
  channels/                  Eve HTTP/dev channel and Telegram webhook channel
  connections/               MCP connections; inert template ends in .txt
  hooks/                     Transcript and token-usage hooks
  lib/                       Agent-side security and embeddings helpers
  tools/                     Host tools exposed to the model
  skills/                    On-demand model procedures
  subagents/                 Declared subagents; planner is the reference pattern

bin/iva.mjs                  Operator CLI and systemd-unit generator

scripts/                     Install-time, polling, memory and maintenance programs
  setup.mjs                  Interactive .env wizard
  telegram-poll.mjs          Long-poll bridge and out-of-band Telegram commands
  daily-digest.ts            Digest entry point
  reminders-run.mjs          Short-lived reminder dispatcher
  workflow-smoke.mjs         Seed/resume workflow durability check
  observe.mjs                Hourly bounded health/capacity collector and alert sender
  build.mjs / start.mjs      Profile-aware Eve build and pre-start mismatch guard
  install-readiness.mjs      Post-install Eve/service readiness gate
  clean-install-smoke.mjs    Disposable first-install and reinstall fixture
  init-vault.mjs             Safe live-vault initialization
  memory/                    Rollup, doctor and embedding-index jobs
  lib/                       Shared implementation modules used by CLI/scripts/agent
  check-*.mjs                Fast contract and invariant tests run by npm test
  release-*.mjs              RC report, provider/vision evidence and seven-day soak gates

examples/extensions/         Inert copyable extension examples; `.txt` prevents auto-discovery
deploy/                      systemd templates and optional PostgreSQL examples
services/telegram-userbot/   Opt-in personal-account Telegram MCP proxy (beta)
vault-template/              Versioned skeleton and maintenance code for a new vault
docs/                        Public product, install, operations and extension docs
notes/                       Planning and launch documents, not runtime code
patches/                     patch-package patches applied by npm postinstall

install.sh                   Bare-server installer and bootstrap entry point
.env.example                 Public configuration reference without secrets
package.json                 Commands and direct dependencies
```

Generated or private paths such as `.env`, `data/`, `vault/`, `.workflow-data`, `.output`, `.eve`,
`deploy/iva-workflow.environment` and Telegram session files are ignored. Do not treat them as code or
commit them.

## Runtime routes

### Telegram message to agent reply

```text
Telegram Bot API
  -> scripts/telegram-poll.mjs
  -> local Eve HTTP endpoint
  -> agent/channels/telegram.ts
     -> allowlist and dispatch rules
     -> attachment/voice/image handling
     -> agent/lib/security-gate.ts
  -> Eve workflow + agent/agent.ts
     -> instructions/tools/skills/subagents
  -> outbound security scan and Telegram formatting
  -> Telegram Bot API
```

Inspect these files first:

- `scripts/telegram-poll.mjs` for long polling, session keys and slash commands handled outside the
  model.
- `agent/channels/telegram.ts` for the authored Telegram channel, media handling and message gates.
- `scripts/lib/telegram-update.mjs`, `telegram-format.mjs` and `telegram-send.mjs` for shared transport
  mechanics.
- `agent/lib/security-gate.ts` for deterministic inbound/outbound filtering.

### Model and provider selection

```text
.env
  -> agent/provider.ts
  -> agent/agent.ts       main text model
  -> agent/vision.ts + agent/lib/vision-provider.mjs
                          shared runtime/release image description
  -> agent/subagents/*    subagent-specific choice where explicitly configured
```

When changing a provider, check both generate and stream paths with
`scripts/check-reasoning-strip.mjs`, then run typecheck and build.

### Conversation and workflow state

```text
agent/agent.ts
  -> scripts/lib/workflow-config.mjs
  -> Eve / Workflow SDK
  -> local .workflow-data OR PostgreSQL Workflow World
```

- `scripts/workflow-smoke.mjs` verifies seed/restart/resume continuity.
- `scripts/postgres-profile.mjs` owns the explicit Ubuntu/Debian enable operation; pure parsing,
  SQL, environment and preflight contracts live in `scripts/lib/postgres-profile.mjs`.
- `deploy/iva-workflow-postgres.environment.example` documents the optional runtime variables.
- `deploy/postgresql-iva.conf` is installed beside the dynamically discovered active config.
- `bin/iva.mjs` owns the CLI route, safe doctor auto-fix, backend-aware reset and service environment.
- `scripts/doctor.mjs` collects layered runtime evidence; `scripts/lib/doctor-contract.mjs` owns the
  sanitized schema, severity/exit-code contract and human rendering.

Workflow state is not long-term personal memory. Changing the Workflow World must not rewrite the
vault.

### Long-term memory

```text
incoming/outgoing message
  -> agent/channels/telegram.ts and agent/hooks/transcript.ts
  -> vault/daily/YYYY-MM-DD.md
  -> systemd memory timers
  -> scripts/memory/rollup.ts
  -> summaries/cards/CORE/MOC
  -> scripts/memory/doctor.ts
  -> vault Git backup

memory question
  -> agent/tools/memory_search.ts
  -> SQLite FTS/BM25 + graph reranking
  -> optional embeddings from agent/lib/embeddings.ts
```

Read [`docs/memory.md`](docs/memory.md) before changing schemas, rollup order or recall behavior.
Changes under `vault-template/.claude` affect only new vaults until explicitly migrated into an
existing live vault.

### Tasks and reminders

```text
agent/tools/tasks.ts       -> data/tasks.json
agent/tools/reminders.ts   -> scripts/lib/reminders-store.mjs -> data/reminders.json
iva-reminders.timer        -> scripts/reminders-run.mjs -> Telegram
```

Reminder delivery is deliberately outside an active model workflow. Do not replace it with detached
shell processes, sleeps or model-created cron jobs.

### Install, service and update lifecycle

```text
install.sh
  -> npm ci
  -> scripts/setup.mjs
  -> eve build
  -> scripts/init-vault.mjs
  -> bin/iva.mjs _install-units
  -> systemd user services/timers

iva update
  -> bin/iva.mjs
  -> scripts/update-runtime.mjs preflight + detached Git worktree
  -> npm ci + tests + typecheck + build + profile canary in staging
  -> scripts/update-manifest.json migration/backup contract
  -> atomic output/dependency activation + regenerated units + restart
  -> iva doctor readiness OR automatic previous-version rollback

iva backup / iva restore
  -> bin/iva.mjs
  -> scripts/backup-runtime.mjs stops every managed writer
  -> scripts/data-manifest.json inventory contract
  -> scripts/lib/portable-backup.mjs private snapshot/checksum/local-or-PostgreSQL restore
  -> build + capability check; restored services remain stopped until explicit `iva start`

iva-observe.timer / iva status
  -> scripts/observe.mjs
  -> scripts/lib/health-metrics.mjs bounded 31-day counters + cooldown/dedup
  -> scripts/workflow-health.mjs read-only storage/queue snapshot
  -> data/health-metrics.jsonl (derived, private, excluded from portable backup)
```

`bin/iva.mjs` is the single source of truth for the installed `iva.service`. Templates for the other
services and timers live in `deploy/`. See [`docs/deploy.md`](docs/deploy.md) and
[`docs/cli.md`](docs/cli.md).

## Change routing

| I want to change… | Start with | Also inspect | Minimum verification |
|---|---|---|---|
| Agent personality/rules | `agent/instructions.md` | `agent/instructions/*` | typecheck, build, prompt canary |
| Provider/model behavior | `agent/provider.ts` | `agent/agent.ts`, `agent/vision.ts`, `agent/lib/vision-provider.mjs` | reasoning/vision tests, typecheck, build |
| Telegram polling/commands | `scripts/telegram-poll.mjs` | `scripts/lib/telegram-*`, channel | Telegram update test, typecheck |
| Telegram media/channel gate | `agent/channels/telegram.ts` | security gate, vision | typecheck, build, media canary |
| Security filtering | `agent/lib/security-gate.ts` | `agent/skills/security-defense/` | security tests, typecheck |
| A model tool | `agent/tools/` | instructions and owning data module | focused check, typecheck, build |
| A skill | `agent/skills/` | `docs/extending.md` | build and trigger canary |
| An MCP connection | `agent/connections/` | connection template, security docs | typecheck, build, auth failure test |
| A subagent | `agent/subagents/` | main instructions/provider | typecheck, build, delegation canary |
| Memory search | `agent/tools/memory_search.ts` | embeddings, `docs/memory.md` | memory tests, typecheck, build |
| Memory rollups/cards | `scripts/memory/rollup.ts` | vault-template rules, doctor | memory fixture test, typecheck |
| Vault health/backup | `scripts/memory/doctor.ts` | memory guards, init-vault | guard tests, test vault dry run |
| Tasks | `agent/tools/tasks.ts` | data-dir handling, digest | typecheck, tool canary |
| Reminders | `agent/tools/reminders.ts` | reminders store/runner/systemd | reminder checks, typecheck |
| Setup wizard/config | `scripts/setup.mjs` | `.env.example`, config docs | setup migration test, public docs test |
| Installer | `install.sh` | setup, init-vault, CLI unit writer | shell check, clean-install test |
| CLI/systemd lifecycle | `bin/iva.mjs` | `deploy/`, CLI/deploy docs | integration invariants, Linux smoke |
| Runtime doctor | `scripts/doctor.mjs` + `scripts/lib/doctor-contract.mjs` | CLI, Workflow health, units, usage/backups | doctor contract, clean-install and both disposable replicas |
| Workflow health/recovery | `scripts/workflow-health.mjs` + `scripts/lib/runtime-recovery.mjs` | CLI, workflow backends, background jobs | runtime recovery check, both disposable replicas |
| Workflow backend | `scripts/lib/workflow-config.mjs` | agent, package versions, smoke script | config test, both builds, restart/resume |
| PostgreSQL profile | `scripts/postgres-profile.mjs` + `scripts/lib/postgres-profile.mjs` | deploy examples, upstream package migrations | config test, real PostgreSQL bootstrap + smoke |
| Update behavior | `scripts/update-runtime.mjs` + `scripts/lib/update-contract.mjs` | CLI, Telegram update, migration manifest | update contract, clean-install build/readiness rollback fixture |
| Backup, restore, server moves | `scripts/data-manifest.json` + `scripts/lib/portable-backup.mjs` | backup runtime, CLI, data docs, both Workflow profiles | manifest/restore contract, both disposable replicas, clean-host drill |
| Health metrics and capacity | `scripts/lib/health-metrics.mjs` + `scripts/observe.mjs` | doctor, status, Workflow health, observe timer | health metrics contract, doctor contract, both disposable replicas |
| Extension contract or example | `scripts/extension-contracts.json` + `examples/extensions/` | extending docs, security, capability manifest | extension contract test, capability diff, relevant behavior canary |
| Release engineering | `scripts/release-contract.json` + `.github/workflows/release-candidate.yml` | releasing/supported/owner docs, provider and soak gates | release contract test, full RC matrix |
| Public documentation | `docs/README.md` | README files and docs checks | `npm test` |
| Telegram userbot beta | `services/telegram-userbot/` | connection + skill + userbot docs | Python tests, typecheck, opt-in smoke |

## Test routing

`npm test` runs the fast JavaScript contract suite:

| Test | Main responsibility |
|---|---|
| `check-reasoning-strip.mjs` | Provider reasoning compatibility for generate/stream. |
| `check-workflow-config.mjs` | Workflow resolver, precedence, descriptor and mismatch contract. |
| `check-runtime-recovery.mjs` | Run-state classification, recovery/reset contract, restart guard and bounded background sessions. |
| `check-doctor-contract.mjs` | Layered schema, severity/exit codes, fault matrix, redaction and one-screen human output. |
| `check-health-metrics.mjs` | Bounded rotation, baseline, growth projection, alert cooldown and deduplication. |
| `check-extension-contracts.mjs` | Config/dependency activation, background ownership, inert removal and source safety. |
| `check-release-contract.mjs` | Immutable candidate identity, required matrix, provider evidence and continuous soak rules. |
| `check-update-transaction.mjs` | Preflight, sequential migration, backup/restore and activation rollback ordering for both profiles. |
| `check-reminders-store.mjs` | Reminder persistence and scheduling behavior. |
| `check-telegram-update.mjs` | Out-of-band Telegram update flow. |
| `check-memory-guards.mjs` | CORE and vault failure guards. |
| `check-integration-invariants.mjs` | Cross-file service/security invariants. |
| `check-capability-manifest.mjs` | Sanitized capability snapshot and required core surface. |
| `check-core-canaries.mjs` | Isolated task, reminder, memory and mocked Telegram behavior. |
| `check-install-readiness.mjs` | Installer false-success decision matrix and shell contract. |
| `check-test-policy.mjs` | CI workflow, verification command and testing-policy contract. |
| `check-public-docs.mjs` | Versions, public claims, local links and secret patterns. |

Additional tests:

- `npm run typecheck` checks authored TypeScript.
- `npm run build` checks Eve discovery, compilation, packaging and the selected Workflow artifact;
  it writes `.output/iva-workflow-profile.json` for the startup/doctor mismatch gate.
- `npm run verify:pr` is the standard pull-request gate: tests, typecheck and build.
- `npm run replica:local` builds and starts a disposable Eve replica with a loopback mock provider;
  it checks first reply, doctor storage probe/redaction, a model-driven task call and local workflow restart/resume.
- `npm run replica:postgres` adds a real disposable PostgreSQL database, official bootstrap,
  schema/doctor write-read checks, idempotent re-bootstrap and restart/resume without local workflow files.
- `npm run replica:install` runs the installer twice in a disposable home with mock provider,
  Telegram and systemd boundaries; it checks readiness, `0600` files and vault preservation.
- `npm run baseline:resources -- --json` runs 100 deterministic replica turns and reports sanitized
  build/start/first-response, idle CPU/RSS and workflow-state sizes.
- `npm run release:check` emits an immutable commit/tag-bound matrix report; live provider and soak
  scenarios remain missing until their separately authorized evidence passes.
- `npm run release:provider -- --json` is a bounded live-provider/vision gate and requires explicit
  `RELEASE_LIVE_CANARY=1` authorization.
- `npm run release:soak -- --json` validates seven continuous days of commit-bound private health
  samples plus a reviewed P0/P1 incident list.
- `python3 -m unittest services/telegram-userbot/test_guardrails.py` checks userbot guardrails.
- `node --env-file=.env scripts/workflow-smoke.mjs seed|resume` is a live runtime check, not a unit
  test.

Build success does not prove database bootstrap, Telegram delivery or restart recovery. Those require
integration checks against the selected runtime profile.

## Editing boundaries

- Preserve unrelated user changes in a dirty worktree.
- Do not edit `node_modules`; dependency fixes belong in `patches/` or an upstream/version change.
- Do not edit `.output`, `.eve`, `.workflow-data`, live `vault/` or generated systemd units as source.
- Do not copy production `.env`, Telegram sessions, vault contents or database dumps into tests.
- Keep the live vault separate from `vault-template/`.
- Do not start background processes from agent tools. Long-lived work belongs to managed services or
  short-lived systemd timers.
- Keep PostgreSQL optional until its clean-install, migration, update and restore lifecycle passes the
  product release gates.

## Detailed documentation

- [`docs/install.md`](docs/install.md) — clean installation.
- [`docs/configuration.md`](docs/configuration.md) — environment and wizard.
- [`docs/deploy.md`](docs/deploy.md) — services, timers and deployment.
- [`docs/PRODUCTION_ARCHITECTURE.md`](docs/PRODUCTION_ARCHITECTURE.md) — production topology.
- [`docs/memory.md`](docs/memory.md) — memory model and recall.
- [`docs/security.md`](docs/security.md) — trust boundaries.
- [`docs/extending.md`](docs/extending.md) — skills, tools, connections and subagents.
- [`docs/testing.md`](docs/testing.md) — automated gates, disposable replicas and production limits.
- [`docs/releasing.md`](docs/releasing.md) — immutable release candidates, matrix evidence and soak.
- [`docs/supported.md`](docs/supported.md) — supported environment and known limitations.
- [`docs/owner-runbook.md`](docs/owner-runbook.md) — concise owner operations.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — operator diagnosis.

Keep this map short enough to scan. Update paths and ownership when a subsystem moves; put detailed
behavior in the owning documentation instead of growing a second manual here.
