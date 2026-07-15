# Iva product baseline

This report is the review record for stabilization stage 0. Machine-readable capabilities are owned
by `scripts/baselines/capability-manifest.json` and generated from repository sources with
`npm run manifest`.

## Baseline identity

- Product version: `0.2.5`
- Source commit: `9eb94c4` (`main`, 2026-07-15)
- Node contract: `24.x`
- Eve: `0.11.10`
- Default workflow profile: local
- Opt-in workflow profile: PostgreSQL (`@workflow/world-postgres` `5.0.0-beta.23`)

The capability snapshot records 10 tools, 6 skills, 2 hooks, 2 channels, 1 connection, 1 subagent,
2 always-managed services, 6 managed timers, 6 timer-triggered services, and 1 opt-in service.

## Resource baseline

### Release baseline

- Captured: `2026-07-15T17:37:44.623Z`
- Source commit: `1ec153b1f34211000554ee480f89f74cabd3755b` (`main`, clean checkout)
- Fixture: `linux-x64`, Node `v24.18.0`, local workflow, loopback mock provider
- Workload: 10 batches of 10 independent turns with server restart between batches
- GitHub Actions run: `29437151972`

| Measurement | Observed value |
|---|---:|
| Build duration | 4,296 ms |
| Startup to health | 1,530 ms |
| First response | 392 ms |
| Idle server CPU | 17.1% sample |
| Idle server RSS | 275,820 KiB |
| Workflow state after 1 turn | 148,792 bytes |
| Workflow state after 10 turns | 1,889,907 bytes |
| Workflow state after 100 turns | 19,178,248 bytes |

The disposable collector also produced the following developer reference. It remains useful for
comparing the procedure across machines, but it is not the release baseline because the worktree was
dirty and the Mac used Node 26 rather than the product's Node 24 contract.

### Developer reference (not a release gate)

- Captured: `2026-07-15T15:57:34.955Z`
- Source HEAD: `9eb94c43f1da980f9bdb28519bcd77460036a761` with uncommitted stage-0 changes
- Fixture: `darwin-x64`, Node `v26.3.0`, local workflow, loopback mock provider
- Workload: 10 batches of 10 independent turns with server restart between batches

| Measurement | Observed value |
|---|---:|
| Build duration | 21,859 ms |
| Startup to health | 5,116 ms |
| First response | 984 ms |
| Idle server CPU | 0% sample |
| Idle server RSS | 205,388 KiB |
| Workflow state after 1 turn | 148,896 bytes |
| Workflow state after 10 turns | 1,878,218 bytes |
| Workflow state after 100 turns | 19,205,780 bytes |

### Follow-up observation

A preliminary long single-session run on the developer Mac exposed stale `session.waiting` stream
boundaries and `MaxListenersExceededWarning` after roughly 10–16 continuation turns. The resource
workload therefore measures independent turns in bounded batches and does not hide this behavior in
its numbers. A dedicated long-context/compaction regression belongs to the runtime recovery and
observability stages; it must be reproduced on Ubuntu/Node 24 before assigning severity.

| Measurement | State | Fixture/procedure |
|---|---|---|
| Idle CPU and RSS | release baseline captured | clean Ubuntu fixture, local profile; longer soak belongs to stage 8 |
| `.workflow-data` after 1/10/100 turns | release baseline captured | local profile with deterministic mock-provider turns |
| Start and first-response time | release baseline captured | mock provider for infrastructure timing; live-provider canary recorded separately |
| Build duration | release baseline captured | clean dependency cache on the Ubuntu fixture |

The fixture report must record immutable commit, OS/architecture, Node version, storage profile,
provider mode, sample count, and measurement commands. Secrets, user identifiers, transcripts, vault
contents, and production logs must never be included.

## Minimum canary set

| Canary | Expected proof | Execution boundary |
|---|---|---|
| Text reply | accepted inbound message produces a non-empty reply | mock provider in CI; small live-provider release canary |
| Memory write/recall | a synthetic fact is written and recalled from an isolated test vault | disposable vault only |
| Tool call | model invokes a harmless deterministic tool and receives its result | sandbox fixture |
| Task | create/list/complete round trip persists across process restart | disposable data directory |
| Reminder | due reminder is claimed once and delivered once | mock Telegram endpoint and disposable data directory |
| Restart/resume | seeded workflow resumes after service/process restart | both storage profiles |
| Telegram delivery | formatted/chunked reply reaches the expected mock endpoint | mock Bot API in CI; production canary only at release gate |

Live-provider and production canaries are deliberately outside the per-PR unit suite. They must not
reuse the production vault or expose private runtime data.

The task, reminder, memory-recall, and mocked Telegram-delivery rows are automated by
`scripts/check-core-canaries.mjs`. Text reply, model-driven task selection, task persistence, and
local workflow restart/resume are automated by `scripts/replica-smoke.mjs` in a disposable Eve
replica. PostgreSQL continuity and the external Telegram route remain later replica-gate work.

## Review rule

`npm test` compares the generated manifest with the checked-in snapshot and separately asserts the
minimum core capabilities. Any manifest diff must be reviewed and the snapshot refreshed
intentionally; unexplained capability removal blocks the change.
