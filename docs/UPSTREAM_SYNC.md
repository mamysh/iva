# Updating Iva From Upstream

Product branch: `codex/iva-prod`.

Upstream branch: `upstream/main` (`https://github.com/smixs/iva.git`).

Memory/vault is not part of the app repository. Keep live memory in a separate repository and point the app to it with `ASSISTANT_VAULT_DIR` (production: `/home/iva/vault`).

## Local Sync

```bash
git switch codex/iva-prod
npm run sync:upstream
```

If Git stops on conflicts, resolve them with these product rules:

- Preserve Telegram polling, Telegram MCP, Deepgram, and Telegram image vision fallback.
- Preserve `IVA_PORT`/`ASSISTANT_HOST` handling.
- Preserve `ASSISTANT_VAULT_DIR`; never move live memory into the app repo.
- Prefer upstream docs/site copy unless it removes product-specific install or ops details.

Then:

```bash
git add <resolved-files>
npm run typecheck
npm run build
git commit
git push
```

## Production Deploy

Run on the VPS as `root`, but execute app commands as user `iva`.

```bash
runuser -u iva -- bash -lc '
set -euo pipefail
cd /home/iva/vault
git add -A
git commit -m "chore: vault backup before app update" || true
git push || true

cd /home/iva/iva
git fetch origin upstream --tags --prune
git switch codex/iva-prod
git pull --ff-only origin codex/iva-prod
npm ci
npm run typecheck
npm run build
'

uid=$(id -u iva)
XDG_RUNTIME_DIR=/run/user/$uid runuser -u iva -- systemctl --user restart iva.service iva-telegram-poll.service iva-telegram-mcp.service
XDG_RUNTIME_DIR=/run/user/$uid runuser -u iva -- systemctl --user --no-pager --plain status iva.service iva-telegram-poll.service iva-telegram-mcp.service
```

## Good Defaults

Enable Git conflict memory once:

```bash
git config --global rerere.enabled true
git config --global rerere.autoupdate true
```

This lets Git remember repeated conflict resolutions between Iva product changes and Shima's upstream changes.
