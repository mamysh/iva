# Supported versions and known limitations

This page describes the release contract, not every environment where Iva may happen to run.

## Supported self-host baseline

- Node.js 24.x.
- Ubuntu 24.04 LTS.
- Linux x64. ARM64 is not in the release matrix yet.
- The default local Workflow profile, or the opt-in PostgreSQL 17 profile.
- A single owner and one active Telegram polling installation per bot token.

The exact machine-readable contract is in
[`scripts/release-contract.json`](../scripts/release-contract.json). A release candidate is valid only
when its immutable `vX.Y.Z-rc.N` tag matches `package.json`, the full matrix belongs to that commit,
and the capability manifest hash is recorded in the report.

## Provider status

Iva has four provider routes: Ollama Cloud, OpenCode Zen, OpenRouter and OpenAI through Codex OAuth.
A stable release requires a bounded live vision canary on a disposable one-pixel image and an
authenticated model inventory check where that provider exposes one. The canary records model names,
counts and response length only; it never records credentials or the returned description.

Provider model availability, prices, regional access and subscription terms are controlled by the
provider and can change independently of an Iva release.

## Known limitations

- Telegram userbot remains opt-in beta and is not part of stable core.
- PostgreSQL remains opt-in. A seven-day soak can qualify a release, but changing the default backend
  requires a separate 30-day observation.
- Ubuntu 22.04, Debian, Linux ARM64, Windows, macOS production hosting and Vercel deployment are not
  stable release-matrix targets yet, even where the installer may work.
- A live provider canary requires owner-supplied access and may incur one small provider request.
- Automated tests use a mock Telegram endpoint. Production receives only bounded post-deploy checks;
  it is never the automated test environment.
- One successful personal VPS does not make an experimental component generally stable.
- The public `main` branch is a development/update channel. General users should install from the
  `stable` branch named in stable release notes; that branch must never point at an RC.

See [testing](testing.md) for gates and [releasing](releasing.md) for the release procedure.
