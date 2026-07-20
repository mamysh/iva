# Extending

Everything Iva does is a file in `agent/`. Drop a new one, rebuild, restart — eve picks it up. No plugin API, no registry. On the server every change ships the same way: `npm run build`, then `iva restart` ([cli.md](./cli.md)).

The existing file contracts are indexed in the sanitized
[`scripts/extension-contracts.json`](../scripts/extension-contracts.json). This is documentation and
validation metadata, not a runtime plugin loader. Inert copyable examples live under
[`examples/extensions/`](../examples/extensions/); their `.txt` suffix prevents Eve from discovering
half-configured code.

## Contract checklist

| Type | Source | Minimum activation proof | Capability manifest |
|---|---|---|---|
| Provider | `scripts/lib/model-catalog.mjs` + `agent/provider.ts` | role defaults, required access, reasoning/vision test, replica turn | `agent.providerRoute.providers` |
| Tool | `agent/tools/<name>.ts` | zod input, bounded execute fixture, declared writes | `agent.capabilities.tools` |
| Skill | flat Markdown or `<name>/SKILL.md` | trigger and non-trigger canary | `agent.capabilities.skills` |
| Channel / MCP connection | `agent/channels/` or `agent/connections/` | config/dependency gate, auth, isolated probe | channels/connections |
| Hook | `agent/hooks/<name>.ts` | synthetic event, bounded/idempotent projection | `agent.capabilities.hooks` |
| Subagent | `agent/subagents/<name>/` | required provider config, structured delegation canary | `agent.capabilities.subagents` |
| Background job | `scripts/` + owned systemd service/timer | service, logs, health, uninstall and duplicate-run fixture | systemd services/timers |
| Memory processor/indexer | `scripts/memory/` | synthetic vault plus recall/rebuild fixture | storage/systemd contract |

For every type, define required/optional config, which values are secrets, timeout and retry policy,
health evidence, side effects, idempotency, a disposable fixture, and where discovery appears in
`npm run manifest`. `npm test` fails if a required contract/example is missing.

## Adding a provider

Use [`provider.ts.txt`](../examples/extensions/provider.ts.txt) as the minimal config shape, add its
role/default metadata to `scripts/lib/model-catalog.mjs`, resolve it in `scripts/lib/model-profile.mjs`,
then add the wire adapter to `agent/provider.ts`. Provider config belongs in those owners, not in
`install.sh` or the CLI. Missing required config must fail readiness before the first user turn.
Static keys remain in `.env`; OAuth artifacts remain private runtime files. Add generate/stream
reasoning coverage, an independent vision-role fixture and one disposable replica turn. A provider
addition changes the reviewed capability snapshot but does not require an installer-core change.

## Adding a tool

Copy [`tool.ts.txt`](../examples/extensions/tool.ts.txt) to `agent/tools/<name>.ts`. Keep the schema
small, bound every process/network call, and test `execute` directly with synthetic data. Declare
reads/writes in the description and owning documentation. Never automatically retry a mutation
without a durable idempotency identity.

## Adding a skill

Skills are markdown procedures in `agent/skills/` that the model loads on demand. The frontmatter `description` is the only part the model sees before loading — write it as a trigger condition ("Use when…"), not a summary. Two shapes work: a flat `<name>.md`, or a `<name>/` directory with a `SKILL.md` plus supporting files. The four bundled skills are your templates, simplest first:

- 📋 **morning-digest.md** — one tool call (`tasks`), grouping rules, output format. Copy this for any "call a tool, format the result" job.
- 🔎 **web-research.md** — a 4-step chain: `web_search` → pick 2–4 sources → `web_fetch` each → synthesize with links.
- 🌐 **agent-browser/** — directory skill wrapping a CLI the model drives through `bash`.
- 🛡 **security-defense/** — the full shape: `SKILL.md`, bundled scripts, a patterns file.

If Iva should reach for your skill unprompted, name it in `agent/instructions.md` — that's how all four above get triggered.

## MCP connections

Drop `agent/connections/<name>.ts` — the filename becomes the connection name. `example.ts.txt` in that folder is the inert template (the `.txt` suffix keeps eve from loading it half-configured):

```ts
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.example.com/sse", // Streamable HTTP or SSE endpoint
  description: "What this server does — the model reads this.",
  auth: { getToken: async () => ({ token: process.env.EXAMPLE_MCP_TOKEN ?? "" }) },
  // tools: { allow: ["search", "get_item"] },  // optional: restrict, add approval
});
```

The model discovers the server's tools through the built-in `connection_search` and calls them as `connection__<name>__<tool>`. The URL and token stay on the runtime side: keys live in `.env` and are never visible to the model.

Optional config and dependencies are checked before activation. A missing token, endpoint, package,
binary or session must leave the extension inactive with a concrete diagnostic; it must not make the
core agent fail. Restrict the remote tool surface and require approval for sensitive writes. The
Telegram userbot remains a separate opt-in beta (`iva userbot setup`) until its own security and
reliability gate is complete.

## Channels and hooks

Use [`channel.ts.txt`](../examples/extensions/channel.ts.txt) and
[`hook.ts.txt`](../examples/extensions/hook.ts.txt). Production channels need fail-closed auth and
transport tests. Hook handlers run in the agent lifecycle: keep them short, never wait on an
unbounded external call, and use an event identity if duplicate delivery could repeat a write.

## Subagents

A subagent is `agent/subagents/<name>/` with an `agent.ts` and its own `instructions.md`. The bundled `planner` is the pattern: its `description` tells the main agent when to delegate ("break a large goal into steps"), and a zod `outputSchema` forces a structured, validated reply instead of prose:

```ts
outputSchema: z.object({
  goal: z.string(),
  steps: z.array(z.object({
    title: z.string(), detail: z.string(), priority: z.enum(["low", "med", "high"]),
  })),
}),
```

A subagent brings its own provider and model: the planner pins Ollama Cloud (`OLLAMA_API_KEY` / `OLLAMA_MODEL`) in its `agent.ts`, independent of the main agent's `MODEL_PROVIDER` — so a cheap model for a narrow job costs nothing extra to wire.

The inert minimal shape is under [`examples/extensions/subagent/`](../examples/extensions/subagent/).
Fail activation when its provider config is missing. Prefer structured task-mode output with no tools;
the parent agent should own mutations.

## Background jobs and memory processors

Persistent work is never launched with `nohup`, `&`, `setsid`, `disown`, a detached Node child, or a
sleep loop from an agent turn. Use a short-lived `Type=oneshot` systemd service and timer. The feature
must own:

- its service and timer templates;
- finite runtime/network/process timeouts;
- `journalctl` logs and an explicit health result;
- duplicate-run/idempotency behavior;
- inclusion in `iva backup` writer shutdown when it writes managed state;
- removal through `iva uninstall`.

See the inert background job/service/timer examples and the real `iva-observe` and reminders units.
Memory processors follow the same ownership rule. Indexes must be rebuildable and must never rewrite
source memory as a side effect; source-vault transforms require an atomic, idempotent fixture.

## Changing the character

Iva's voice lives in exactly one file: `agent/instructions.md` — tone, rules, tool preferences, hard limits. Edit it directly. It is deliberately language-neutral: the reply language comes from `AGENT_LANGUAGE` in `.env`, read at startup by `agent/instructions/05-language.ts` (changing it needs a rebuild + restart). The other files in `agent/instructions/` are machinery, not character — `10-map.md` (memory protocol), `20-core.ts` (injects the vault's CORE.md), `now.ts` (date/time).

What Iva knows about *you* is memory, not code — that's `CORE.md` in the vault ([memory.md](./memory.md)).

## Local development

```bash
npm ci        # postinstall applies patches/eve+0.11.10.patch
npm run dev   # eve dev TUI, server on http://127.0.0.1:2000
npm exec -- eve dev --no-ui --logs all   # headless
```

The TUI is a full chat — skills, tools and subagents all work without Telegram. To smoke-test the tool loop from a script, drive the dev server with `eve/client`:

```js
import { Client } from "eve/client";
const session = new Client({ host: "http://127.0.0.1:2000" }).session();
const res = await session.send("Add a task: buy coffee, high priority.");
console.log((await res.result()).message);
```

Two gotchas:

- ⚠️ **Schedule crash** — `eve dev` crashes if a schedule handler in `agent/` imports another authored module (a channel, for instance). That's why the repo ships no `agent/schedules/*.ts`: on a VPS `defineSchedule` never fires anyway, systemd timers do that job ([deploy.md](./deploy.md)).
- 🩹 **patch-package** — `patches/eve+0.11.10.patch` makes deterministic model-call errors (invalid prompt, unknown tool) fail fast instead of retrying forever.
- 🧪 **Eve bumps** — run `npm test`, `npm run typecheck` and `npm run build` after changing `eve`; the tests include a deterministic model-error check and workflow backend config checks.
