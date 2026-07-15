import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createReminder,
  duePending,
  loadReminders,
  markDelivered,
  saveReminders,
} from "./lib/reminders-store.mjs";
import { sendTelegramHtml } from "./lib/telegram-send.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const sandbox = await mkdtemp(join(tmpdir(), "iva-core-canaries-"));
const results = [];

async function canary(name, run) {
  const started = performance.now();
  await run();
  results.push({ name, ok: true, durationMs: Math.round(performance.now() - started) });
}

function callTaskTool(dataDir, input) {
  const toolUrl = pathToFileURL(join(ROOT, "agent/tools/tasks.ts")).href;
  const program = [
    `const tool = (await import(${JSON.stringify(toolUrl)})).default;`,
    "const result = await tool.execute(JSON.parse(process.argv[1]));",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const stdout = execFileSync(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify(input)], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_DATA_DIR: dataDir },
  });
  return JSON.parse(stdout);
}

try {
  await canary("task persistence across process restart", async () => {
    const dataDir = join(sandbox, "task-data");
    const added = callTaskTool(dataDir, { action: "add", text: "synthetic canary task", priority: "high" });
    assert.equal(added.ok, true);
    assert.equal(added.added.id, 1);

    const listedAfterRestart = callTaskTool(dataDir, { action: "list", includeDone: true });
    assert.equal(listedAfterRestart.count, 1);
    assert.equal(listedAfterRestart.tasks[0].text, "synthetic canary task");

    const completedAfterRestart = callTaskTool(dataDir, { action: "done", id: 1 });
    assert.equal(completedAfterRestart.done.done, true);
    const finalState = callTaskTool(dataDir, { action: "list", includeDone: true });
    assert.equal(finalState.tasks[0].done, true);
  });

  await canary("reminder persists and is delivered once", async () => {
    const file = join(sandbox, "reminder-data", "reminders.json");
    const reminder = createReminder({
      text: "synthetic canary reminder",
      dueAt: new Date(Date.now() - 1_000).toISOString(),
      timezone: "UTC",
      chatId: "synthetic-chat",
    });
    await saveReminders([reminder], file);

    const due = duePending(await loadReminders(file));
    assert.equal(due.length, 1);
    markDelivered(due[0]);
    await saveReminders(due, file);

    const afterRestart = await loadReminders(file);
    assert.equal(afterRestart[0].status, "sent");
    assert.equal(afterRestart[0].sentCount, 1);
    assert.equal(duePending(afterRestart).length, 0);
  });

  await canary("memory write and lexical recall", async () => {
    const vault = join(sandbox, "vault");
    await mkdir(join(vault, "cards"), { recursive: true });
    await writeFile(
      join(vault, "cards", "canary-fact.md"),
      "---\nname: Canary fact\nstatus: active\nconfidence: HIGH\n---\nThe launch phrase is cedar aurora 4729.\n",
      "utf8",
    );
    await writeFile(join(vault, "cards", "distractor.md"), "A completely unrelated synthetic note.\n", "utf8");

    process.env.ASSISTANT_VAULT_DIR = vault;
    process.env.MEMORY_SEARCH_MODE = "bm25";
    delete process.env.MEMORY_EMBED_URL;
    delete process.env.JINA_API_KEY;
    delete process.env.DEEPINFRA_API_KEY;

    // Authored TypeScript uses the build-time .js import convention. This test hook mirrors Eve's
    // resolver so Node can execute the source module directly without creating files in agent/.
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.endsWith("/embeddings.js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        return nextResolve(specifier, context);
      },
    });
    const { searchMemory } = await import("../agent/tools/memory_search.ts");
    const result = await searchMemory({ query: "cedar aurora 4729", limit: 3, scope: ["cards"] });
    assert.ok(result.count >= 1);
    assert.equal(result.hits[0].file, "cards/canary-fact.md");
    assert.match(result.hits[0].snippet, /cedar aurora 4729/i);
  });

  await canary("Telegram HTML delivery and plain fallback", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    try {
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      const delivered = await sendTelegramHtml("synthetic-bot", "synthetic-chat", "**Canary** delivery");
      assert.deepEqual(delivered, { ok: true, fellBack: false, error: "" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.chat_id, "synthetic-chat");
      assert.equal(calls[0].body.parse_mode, "HTML");
      assert.match(calls[0].body.text, /<b>Canary<\/b>/);

      calls.length = 0;
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return calls.length === 1
          ? new Response("bad entities", { status: 400 })
          : new Response(JSON.stringify({ ok: true }), { status: 200 });
      };
      const recovered = await sendTelegramHtml("synthetic-bot", "synthetic-chat", "**Fallback** delivery");
      assert.deepEqual(recovered, { ok: true, fellBack: true, error: "" });
      assert.equal(calls.length, 2);
      assert.equal(calls[1].body.parse_mode, undefined);
      assert.equal(calls[1].body.text, "Fallback delivery");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, canaries: results }, null, 2)}\n`);
else {
  for (const result of results) console.log(`ok core canary: ${result.name} (${result.durationMs}ms)`);
}
