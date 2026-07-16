# Troubleshooting

Every entry below is a real failure someone hit, and the fix that shipped. Find your symptom, run the command. Env-var details live in [configuration.md](configuration.md); the full command reference in [cli.md](cli.md).

## Common issues

### Start here: one diagnostic report

Run `iva doctor`. It checks configuration, the built/runtime storage profile, services and readiness,
Workflow storage, Telegram, provider activity, memory/index jobs, backups and disk capacity. It may
rebuild missing output or restore generated units/services/timers; it never resets Workflow state,
deletes data, changes credentials or sends a Telegram/model test message.

`blocked` means replies are unavailable and the command exits `1`. `degraded` means a non-blocking
warning needs attention but Iva can still reply; it exits `0`. Every failed check prints the next
manual command. For support or CI, capture `iva doctor --json`: it performs no auto-repair and removes
credentials, connection URLs, user/chat IDs, private paths and memory contents.

### Build killed / exit 137

Cause: `eve build` needs more RAM than a small VPS has — the kernel OOM-kills it. The installer normally adds a swapfile to prevent this ([install.md](install.md)), but skips it when free disk is too low. Add one by hand:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
cd ~/iva && npm run build
```

### Bot silent after iva config

Cause: before 0.1.4 the wizard saw Iva's own port as "busy", moved `IVA_PORT` 8723 → 8724 and left `ASSISTANT_HOST` on the old one — the bridge talked to a port nobody listened on.

```bash
iva update                                       # 0.1.4+ keeps the port and syncs the host
grep -E '^(IVA_PORT|ASSISTANT_HOST)' ~/iva/.env  # the two ports must match
iva restart
```

### Turn stuck / no reply

First inspect the runtime. `iva status` reports active, waiting, retrying, failed and wedged runs, plus queue and storage health.

```bash
iva status
iva recover   # safe repair and re-enqueue; no workflow data is deleted
```

If workflow storage is unavailable, recovery stops without changing state: restore disk/database access and run `iva recover` again. If a run remains wedged and you deliberately accept losing active conversations, run `iva reset`; it asks for confirmation, cancels active sessions through the Workflow API and preserves terminal history, the vault, tasks and reminders on both local and PostgreSQL backends.

From Telegram, `/restart` restarts only the agent process. `/new`, `/clear` and `/compact` perform the explicit active-session reset. The poll bridge handles these out-of-band, so they work even while the agent is busy.

Both services use a bounded systemd restart policy: five starts in five minutes, then cooldown instead of an endless restart loop.

### Reminder shows delivery_unknown

The dispatcher durably claimed the reminder, but could not prove whether Telegram accepted it before the process or network failed. Iva does not resend it automatically because that could create a duplicate. Check the chat and service log, then cancel and recreate the reminder if it was not delivered.

### Model changed in .env but nothing happened

Cause: the model is read once, at process start.

```bash
iva restart
```

### Voice note over 20MB ignored

Cause: Telegram's Bot API download cap ([providers.md](providers.md)) — the bridge never receives the audio. Split before sending:

```bash
ffmpeg -i note.m4a -f segment -segment_time 600 -c copy part%02d.m4a
```

### iva update fails after force-push

Cause: versions before 0.1.7 ran `git pull --ff-only`, which aborts when `main` was rewritten upstream. Bootstrap past it once by hand:

```bash
cd ~/iva && git fetch origin main && git reset --hard origin/main
iva update   # from here on, update handles divergence itself
```

`.env` and the vault are untracked — `reset --hard` doesn't touch them.

Current versions detect rewritten deployment history before activation and run the same transactional
update. `ROLLED BACK` means either staging checks rejected the target while the old service kept
running, or post-start readiness failed and Iva restored the previous commit, `.output`, dependencies
and generated units. Run `iva doctor`; the retained previous transaction metadata is under the ignored
`.iva-update/previous/` directory. Do not delete it while investigating a rollback.

If preflight reports `sequential update required`, the target contains more than one migration hop.
Deploy the intermediate release first. If it reports backup blocked, install/fix the required
PostgreSQL dump tools or restore access to local Workflow storage; update will not stop the service.

### gh not available warnings

Cause: the nightly doctor backs your vault up to a private `iva-vault` GitHub repo through `gh`; unauthenticated `gh` means no off-box backup.

```bash
gh auth login                                      # the installer already put gh on the box
systemctl --user start iva-memory-doctor.service   # backup now: creates the private repo and pushes
```

`iva doctor` only reports a missing vault origin — the repo creation and push happen in the nightly memory-doctor job (`npm run doctor`); the second command runs it immediately instead of waiting for 05:00.

### Vault push rejected for large files

This is not an authentication problem. Inspect the memory-doctor journal for `GH001`, `Large files`
or `exceeds GitHub's file size limit`:

```bash
journalctl --user -u iva-memory-doctor.service -n 120 --no-pager
git -C "${ASSISTANT_VAULT_DIR:-vault}" status --short --branch
```

Do not force-push or delete memory blindly. Create a `git bundle create ... --all` backup first,
identify which unpushed commits introduced the blobs, and rewrite only that unpublished tail. Current
versions report oversized-history failures separately from credential failures.

### agent-browser fails on Ubuntu 24.04

Cause: Ubuntu 23.10+ blocks unprivileged user namespaces (AppArmor), so Chromium dies with "No usable sandbox". The installer writes the workaround; if it's missing:

```bash
echo '{ "args": "--no-sandbox" }' > ~/.agent-browser/config.json
agent-browser open about:blank && agent-browser close --all   # launch check
```

## Lifecycle

### Migrate to a new server

The step-by-step procedure — what to copy off the old box and how to restore it on the new one — is in [deploy.md](deploy.md) ("Moving servers").

### Restore memory from the iva-vault repo

The doctor commits and pushes the vault nightly at 05:00, so the remote is at most a day behind.

```bash
rm -rf ~/iva/vault
gh repo clone <user>/iva-vault ~/iva/vault
iva restart
```

### Uninstall

`iva uninstall`, with `--purge` to also delete code and vault — push the vault first; there is no undo. Details: [cli.md](cli.md).
