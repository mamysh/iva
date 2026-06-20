# MCP-подключения

eve автоматически подхватывает любой `agent/connections/<name>.ts` как MCP/OpenAPI-подключение.
Модель видит инструменты сервера через встроенный `connection_search` и зовёт их по имени
`connection__<name>__<tool>`. URL и ключи модель НЕ видит — они на стороне рантайма.

## Как добавить MCP-сервер
1. Скопируй `example.ts.txt` → `<имя>.ts` (имя файла = имя подключения).
2. Впиши `url`, `description`, при необходимости `auth.getToken` (ключ из env).
3. Добавь ключ в `.env`, пересобери (`npm run build`) и перезапусти сервис.

Пример — в `example.ts.txt` (с расширением `.txt`, чтобы eve его НЕ активировал, пока не настроишь).

## Telegram
`telegram.ts` подключает `chigwell/telegram-mcp` через локальный Streamable HTTP endpoint
`TELEGRAM_MCP_URL` (`http://127.0.0.1:8765/mcp` по умолчанию). Сам endpoint запускается отдельно:
`npm run telegram:mcp:setup`, затем `npm run telegram:mcp:serve` или `iva-telegram-mcp.service`.
Connection ограничен read-only инструментами для чтения чатов и истории.
