# Bridge-owned Telegram screens for plugins

Status: experimental proposal, 2026-10-04.

Plugin settings navigation is deterministic. A skill can describe navigation, but each
tap then starts a model turn and sends another message. Telegram message identity,
callback ownership and replacement belong to delivery code rather than the skill.

Use the existing Bridge, plugin manifest namespace and stdio MCP proxy. The plugin
declares a command and handler and returns structured pages. Iva owns callbacks and
the message, validates private owner identity and revision, persists intent/result,
and edits that message. No extra bot, model call, plugin runtime or arbitrary endpoint
is needed. An uncertain action stops the screen; delivery recovery never repeats it.

The stdio proxy currently owns one agent HTTP session. Opening another MCP client from
the Bridge would close it. A narrow authenticated unary `/screen` route invokes only
the manifest-declared tool and correlates its responses separately, preserving the
ordinary MCP path. Only enabled/trusted, unchanged plugin content is accepted.

Native questions remain a separate lifecycle: Eve accepts the response, Iva consumes
all choices and updates the preview from the authoritative `input.resolved` event.
The common Telegram message writer never sends a new message after a failed edit.
The current Eve patch exposes the event publicly rather than overriding its compiled
adapter. This part should be reviewed independently for upstream Eve.

Initial scope is private long-poll chats and trusted stdio MCP. Webhook, remote MCP,
main-menu integration, freeform screen inputs and business writes without their own
confirmation are outside this change. Existing model-mediated buttons stay compatible.
Released Iva requires a plugin fallback until it implements this contract.
