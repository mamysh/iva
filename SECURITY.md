# Security policy

[Русская версия](SECURITY.ru.md)

## Supported versions

Security fixes target the latest tagged release candidate and, after `v0.3.0`, the latest stable
release. The Telegram userbot is opt-in beta and is outside the stable security guarantee.

## Report a vulnerability

Do not open a public issue with credentials, tokens, private logs, vault contents or exploit details.
Use GitHub's **Report a vulnerability** private advisory flow for this repository. Include the affected
version, impact and minimal reproduction without personal data. If private advisories are unavailable,
open a public issue containing only a request for a private contact channel.

Never attach `.env`, OAuth files, SSH keys, database URLs, backups or production logs.

The runtime trust boundaries and hardening model are documented in [docs/security.md](docs/security.md).
