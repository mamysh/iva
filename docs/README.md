# Iva documentation
Iva is a self-hosted Telegram AI assistant with layered memory that turns your messages into an Obsidian-compatible vault.

- [install.md](install.md) — one command on a fresh VPS, from curl to the bot's first message
- [install-testing.md](install-testing.md) — installer stages, idempotence and false-success cases
- [configuration.md](configuration.md) — every `.env` variable and the setup wizard
- [memory.md](memory.md) — how the vault compounds: transcripts, rollups, cards, search
- [security.md](security.md) — injection screening in, secret redaction out, allowlist fails closed
- [providers.md](providers.md) — every external service, with real prices
- [deploy.md](deploy.md) — systemd services and timers, long polling, updates, backups
- [data-and-backup.md](data-and-backup.md) — complete data inventory, verified backup/restore, and server moves
- [observability.md](observability.md) — bounded health metrics, capacity warnings, and alert cooldowns
- [PRODUCTION_ARCHITECTURE.md](PRODUCTION_ARCHITECTURE.md) — reference production stack, PostgreSQL profile, and operational contract
- [userbot.md](userbot.md) — beta personal-account Telegram MCP proxy, tool surface and risks
- [cli.md](cli.md) — Telegram slash commands and the `iva` CLI
- [extending.md](extending.md) — skills, MCP connections, custom tools
- [testing.md](testing.md) — pull-request canaries, disposable replica, production release gates
- [faq.md](faq.md) — short answers on cost, models, privacy, Obsidian
- [troubleshooting.md](troubleshooting.md) — a silent bot, failed timers, provider errors

Документация на русском: [ru/](ru/)
