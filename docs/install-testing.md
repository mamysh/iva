# Installer contract and test cases

The installer must either leave a supported Ubuntu host ready or stop with an exact recovery command.
It must never infer readiness from a successful package install, a direct Telegram Bot API request,
or a momentary `systemctl start` result.

## Stages

| Stage | Preconditions | Idempotent result | Failure and resume |
|---|---|---|---|
| `preflight` | supported CPU, systemd, enough disk and RAM/swap | no product data changed | fix the reported host requirement, rerun installer |
| `packages` | package manager and privilege path known | required packages present | install the named package, rerun installer |
| `runtime` | network and supported architecture | Node 24+ and runtime helpers present | run the printed runtime command, rerun installer |
| `checkout` | Git and destination available | requested commit checked out without touching private data | resolve the reported Git state, rerun installer |
| `dependencies` | checkout and Node ready | lockfile installed | rerun installer after the printed npm failure |
| `setup` | interactive terminal or existing `.env` | complete `.env` with mode `0600`; otherwise configuration pending | `npm run setup`, then rerun installer |
| `build` | dependencies and configuration shape valid | production `.output` exists | fix the build error, rerun installer |
| `vault` | writable configured vault parent | existing memory untouched; empty vault initialized once | inspect the named vault error, rerun installer |
| `units` | configured build and systemd user manager | generated units refreshed and enabled | `iva doctor`, then rerun installer |
| `readiness` | units started | Eve is healthy twice, services are active without a restart loop, fresh journals have no terminal startup error | `iva doctor`, inspect named journal, rerun installer |

The append-only install-state report lives at
`${XDG_STATE_HOME:-$HOME/.local/state}/iva/install-state.jsonl` with mode `0600`. It records only run
ID, these stage names, status, UTC timestamp and a generic recovery command. It must not contain
environment values, tokens, user IDs, vault contents, transcripts or production logs, and it must
never be used as authority to overwrite user data.

## False-success cases

The automated contract must reject all of these as “ready”:

- setup was skipped or `.env` is incomplete;
- build output is missing;
- Eve health fails or succeeds once and immediately fails again;
- either main service or Telegram bridge is inactive;
- either service is restart-looping;
- a fresh service journal contains a terminal startup error;
- a direct Telegram Bot API request succeeds while Eve is unhealthy;
- systemd is unavailable on a host presented as a supported VPS installation.

`scripts/check-install-readiness.mjs` covers the decision matrix without using a live provider,
Telegram, vault or production data. The disposable Ubuntu clean-install test owns the full first-run
and second-run scenarios.
