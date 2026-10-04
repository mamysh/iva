# Plugin screens in Telegram

Experimental proposal. This API is not part of the released Iva 0.4.11.
It supports private chats through the long-poll Bridge and a trusted stdio MCP plugin.
It does not add a button to Iva's main menu.

A plugin declares one command and handler in `plugin.json`:

```json
{
  "extensions": {
    "sh.iva": {
      "telegramScreen": {
        "command": "example",
        "server": "example",
        "tool": "example_screen"
      }
    }
  }
}
```

`server` names an existing stdio entry in `mcp.json`. The installed plugin must be
enabled and trusted and its proxy must be running. The Bridge invokes the declared
tool through the proxy's authenticated `/screen` route. This is not a second MCP
client session: it must leave the agent's existing `/mcp` session alive.
Commands belonging to Iva take precedence. Two plugins declaring the same command
cannot be opened with that command. Webhook mode and remote MCP servers are not supported.

The tool receives `{ "event": ... }`. An opening event has `type: "open"` and
`eventId`. An action event has `type: "action"`, `screen`, `revision`, `actionId`
and `eventId`. `screen` is opaque, not a Telegram message identifier. An action ID
comes from the previous page, never from arbitrary callback contents. The tool
returns one JSON text content item:

```json
{
  "type": "show",
  "view": {
    "markdown": "# Example\n\n**Status**\n\nConnected.",
    "rows": [[{ "id": "refresh", "label": "Refresh" }]]
  }
}
```

To close: `{ "type": "close", "markdown": "Closed." }`. A view contains at most
12 rows of 4 actions, unique action IDs, labels up to 80 characters and markdown
up to 12000 characters. Markdown cannot contain raw button tags; the host creates
all callback buttons. Classic mode uses Telegram HTML and a keyboard and is also
subject to Telegram's 4096-character limit. Rich mode uses embedded buttons. A failed
rich screen send is reported, not silently converted to a page with inert buttons.

The Bridge checks the private chat, allowlist, plugin flags, plugin content fingerprint,
original message, expiry and page revision before every action. State is private,
atomically written under `data/telegram-screens/`; screens expire after 15 minutes.
A per-screen lock serializes taps. The host stores the action intent before calling
the handler and the resulting view before editing the message. Repeating the last
successful tap can repair a failed edit without calling the handler again. An uncertain
action or a restart during it requires reopening the screen; it is not automatically
replayed. Plugin operations must retain their own revision and receipt checks.

The callback is checked by the Bridge, but this is not a sandbox or an independent
authorization service for the plugin's business API. The handler is also an MCP tool
and remains subject to the plugin's own confirmation and validation rules. The existing
proxy bearer is not exposed to the Telegram callback. Plugins do not receive the bot
token or edit arbitrary Telegram messages through this API.

The related [native-question proposal](native-question-previews.md) settles a
preview after Eve accepts an answer. It is a separate change and can be reviewed
independently of the plugin-screen API.

No plugin data migration is required when reverting to released Iva. Plugin authors
must retain their conversational tool/skill fallback until the API is available in
an upstream release. Old screen callbacks expire; they never become model messages.
