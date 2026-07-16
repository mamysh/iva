# Testing and release gates

This document is the source of truth for choosing and executing Iva tests. Contributors and coding
agents apply these gates automatically; they do not wait for a separate request to test a change.

Iva does not use the production installation as its test environment. A code rollback cannot undo a
Telegram message, a memory write, a completed task, a delivered reminder, or every database schema
change. Tests therefore run in progressively more realistic isolation, and production receives only
bounded post-deploy smoke checks.

## Gate 1: every pull request

Run:

```bash
npm run verify:pr
```

`verify:pr` runs `npm test`, TypeScript checking, and the production build in that order. Run the
narrowest subsystem test first when one exists, then run the complete command. Documentation-only
changes may run `npm test` without typecheck/build.

The tracked `.github/workflows/verify.yml` runs this gate, a two-profile local/PostgreSQL build
matrix, and `npm run replica:local` on Ubuntu with Node 24 for every pull request and every push to
`main`. Each matrix build validates its sanitized profile descriptor through the same startup guard.
It uses only repository contents and locked
npm dependencies; no provider, Telegram, vault, deployment, or production secrets are available to
the job.

`npm test` includes the capability-manifest contract and fast core canaries. The canaries use a new
temporary data directory and vault for every run, invoke the task tool in separate Node processes,
force memory search into offline BM25 mode, and replace Telegram network access with an in-process
mock. They never read `.env`, the live vault, production application data, or a Telegram token.

Run the canaries alone with `npm run canary:core`; add `-- --json` for machine-readable output.

This gate currently proves:

- task add/list/complete persistence across process restarts;
- one-time reminder state transition and persistence;
- synthetic memory write and lexical recall;
- Telegram HTML formatting, delivery request, and plain-text fallback;
- the structural capability baseline from `npm run manifest`.
- install readiness rejects incomplete configuration, failed health, inactive/restarting services
  and fresh terminal startup errors.

It does not prove that a model produced a reply or selected a tool. Those paths belong to the replica
gate because they require a running Eve server and a deterministic provider.

### Change-to-gate rules

| Changed surface | Required verification |
|---|---|
| Documentation only | `npm test` |
| Agent, tools, memory, reminders, Telegram, CLI, installer, scripts, dependencies | narrow test, then `npm run verify:pr` |
| Capability added, removed, or renamed | previous row, reviewed manifest diff, updated behavioral canary |
| Provider, Eve, Workflow, storage profile, generated units | previous rows plus the applicable disposable-replica scenario |
| Install, update, migration, recovery, backup/restore | disposable Ubuntu replica; both storage profiles when storage-neutral behavior is claimed |
| Release candidate | all applicable replica scenarios and the release matrix in the PRD |

If a required replica scenario has not been automated yet, record it as a missing gate and implement
or extend the fixture in the owning stabilization stage. Do not substitute production testing and do
not silently declare the scenario passed.

## Gate 2: disposable replica

Run the backend-local replica with:

```bash
npm run replica:local
```

Run the backend-PostgreSQL replica against a disposable database with:

```bash
POSTGRES_FIXTURE_URL=<disposable-test-database> npm run replica:postgres
```

Install the candidate commit on a clean supported Ubuntu fixture. The replica must have its own port,
temporary data directory, disposable vault, workflow state, and mock provider/Telegram endpoint. The
PostgreSQL variant must use a separate temporary database and role; it must never share the production
database or credentials.

The automated local replica currently proves a production build, first text reply, model-driven task
tool selection, task persistence, workflow restart/resume, transient provider 429/500 recovery,
terminal provider failure without retry, SIGTERM during a model step, and SIGKILL between durable
steps without repeating the task side effect. The PostgreSQL variant additionally blocks connections
temporarily and proves automatic return after database availability is restored. `npm run replica:install` additionally runs first install and reinstall in a
disposable home with mock provider, Telegram and systemd boundaries, checking readiness, private-file
modes, vault preservation, and independent Telegram-bridge stop/restart while Eve stays available. The PostgreSQL variant runs the official pinned-package bootstrap on a
fresh real database, verifies the Workflow/Drizzle/Graphile schemas, persists a first turn, repeats
bootstrap without losing runs, resumes after restart, and proves that no local workflow state was
created. Fast recovery contracts additionally inject `ENOSPC`, read-only storage and connection errors
to prove their observable classifications; a true filesystem-capacity fixture remains a release-matrix
scenario. The broader replica gate still owns update/rollback tests.
CI also runs the profile preparer twice on the native Ubuntu runner PostgreSQL cluster. That separate
gate proves dynamic cluster/config discovery, a role matching the actual Unix runner user, peer auth,
idempotent database creation, bootstrap/schema verification and the profile-aware build.
The fixture is destroyed after the run. A dedicated test Telegram bot may be used for a small live
delivery canary, but it must not poll with the production bot token.

## Resource baseline

Run the sanitized local-profile collector with:

```bash
npm run baseline:resources -- --json
```

It performs 100 independent deterministic turns in batches of 10, restarting the disposable server
between batches so waiting sessions do not distort idle resources. It records build, startup and
first-response duration, idle server CPU/RSS, and local workflow-state size after turns 1, 10 and 100. The
report includes only commit/dirty state and fixture metadata; prompts, responses, environment values,
paths and credentials are excluded.

`.github/workflows/resource-baseline.yml` runs the same collector manually on a clean Ubuntu/Node 24
runner and retains the JSON artifact for 30 days. Resource results are observations until repeated
runs justify thresholds; they are not a pass/fail performance gate.

Creating and destroying the disposable fixture is a routine test action and does not require owner
confirmation when it uses local/CI resources and synthetic data. The test runner must choose unique
paths, ports, database names, and roles; fail closed if any resolved path or endpoint points at the
configured production installation.

## Gate 3: production release

Only an immutable commit that passed the previous gates may be deployed. Before a schema-affecting
release, create and verify the required backup. After activation, perform bounded checks: readiness,
expected commit and storage profile, service/timer state, and a single owner-authorized reply canary
when needed. Do not write synthetic facts into the personal vault or create test tasks/reminders.

If readiness fails, stop activation and roll code back. Database rollback is allowed only when the
release has an explicit compatible down-migration or a verified restore plan. Rollback is the safety
net, not the primary testing strategy.

## Autonomy and reporting contract

The implementer proceeds without asking the owner for routine unit tests, builds, mocks, temporary
directories, or disposable replicas. Owner approval is required only for production mutation,
live-provider or production-Telegram activity, credentials/access not already available to the test
fixture, destructive operations, or a product decision that changes scope.

Every completed change reports:

- tests and gates that passed;
- gates that were not applicable;
- gates that could not run and why;
- whether production was touched (normally: no);
- the next missing automated gate, if any.
