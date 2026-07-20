# Contributing

[Русская версия](CONTRIBUTING.ru.md)

Thanks for helping Iva. Start with an issue for product changes that affect installation, data,
providers or public behavior. Keep pull requests small and focused.

1. Fork the repository and branch from `main`.
2. Never commit `.env`, credentials, private logs, vault data, dumps or production state.
3. Run the narrowest relevant test first, then `npm run verify:pr`.
4. Update the English and Russian owner-facing docs when behavior changes.
5. Explain user impact, risks and validation in the pull request.

Architecture and test routing: [CODEBASE_MAP.md](CODEBASE_MAP.md) and [docs/testing.md](docs/testing.md).
Extensions: [docs/extending.md](docs/extending.md). Security reports follow [SECURITY.md](SECURITY.md),
not public issues.
