# Документация Iva

Iva - self-hosted ассистент в Telegram со слоями памяти: всё, что вы ему шлёте, превращается в vault, который открывается в Obsidian.

**Для владельца на русском:**
- [install.md](install.md) - одна команда на чистом VPS, от curl до первого сообщения бота
- [configuration.md](configuration.md) - все переменные `.env` и мастер настройки
- [memory.md](memory.md) - как копится память: транскрипты, выжимки, карточки, поиск
- [security.md](security.md) - инъекции ловятся на входе, секреты вычищаются на выходе, чужим бот молчит
- [providers.md](providers.md) - модели, внешние сервисы и честная схема расходов
- [deploy.md](deploy.md) - сервисы, таймеры, обновления и PostgreSQL
- [data-and-backup.md](data-and-backup.md) - полный backup, restore и перенос сервера
- [observability.md](observability.md) - состояние, место на диске и семидневный baseline
- [userbot.md](userbot.md) - opt-in beta личного Telegram и риски аккаунта
- [cli.md](cli.md) - команды Telegram и серверный CLI
- [owner-runbook.md](owner-runbook.md) - короткая памятка владельца
- [supported.md](supported.md) - поддерживаемые версии и ограничения
- [faq.md](faq.md) - короткие ответы про цену, модели, приватность и Obsidian
- [troubleshooting.md](troubleshooting.md) - бот молчит, обновление откатилось, заканчивается диск

**Документы разработчика пока только по-английски:**
- [extending.md](../extending.md) - скиллы, MCP-подключения, свои инструменты
- [testing.md](../testing.md) - тестовые границы и disposable-реплики
- [releasing.md](../releasing.md) - release matrix, canary и soak
- [install-testing.md](../install-testing.md) - тестирование установщика
- [PRODUCTION_ARCHITECTURE.md](../PRODUCTION_ARCHITECTURE.md) - эталонный production-профиль и эксплуатационный контракт

Русская версия главного README - [README.ru.md](../../README.ru.md).
