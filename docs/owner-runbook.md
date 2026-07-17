# Owner runbook

This is the short operational path for a single-owner Iva installation. Commands run inside the Iva
checkout as the service user unless the installer explicitly asks for `sudo`.

## Install

Follow the one-command stable-channel instruction in the release notes on a fresh supported Linux
host. The installer checks out the moving `stable` branch, which advances only to a fully approved
release tag, so later `iva update` stays on the stable channel. Finish the setup wizard and wait for
the final readiness check. Do not copy a live Telegram token into a second running installation.

## Check health

```bash
iva status
iva doctor
iva doctor --json
systemctl --user list-timers 'iva-*'
```

`iva doctor` may repair safe service drift. The JSON form is sanitized for support. A blocked result
means replies are not reliable; follow its concrete recovery action before making unrelated changes.

## Update

```bash
iva update
```

Update builds and tests a detached staging checkout before activation. A broken build never replaces
the active output; failed readiness restores the previous commit automatically. After `UPDATED`, run
`iva doctor` and confirm the expected commit and timers.

## Recover

```bash
iva doctor
iva recover
iva logs
iva logs poll
```

Use `iva recover` only when doctor recommends Workflow recovery. `iva reset` discards workflow
execution state and requires explicit confirmation; it does not erase the vault. Never delete
PostgreSQL Workflow tables or vault files manually as a first response.

## Move to another server

1. On the old server run `iva backup <private-directory>` and verify the reported artifact.
2. Stop Iva on the old server so it cannot keep polling Telegram.
3. Install the same release on the new supported host.
4. Transfer the private backup out of band and run `iva restore <directory> --yes`.
5. Run `iva doctor`; confirm services remain stopped until the old server is definitely inactive.
6. Run `iva start`, then one bounded reply check.

The full inventory and restore boundary are documented in [data and backup](data-and-backup.md).
