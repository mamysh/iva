import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_SCHEMA_URL, MCP_SCHEMA_URL } from "#lib/plugin-reader.ts";
import {
  pluginRoot,
  pluginDataDir,
  pluginTokenFile,
  writePluginsState,
} from "#lib/plugin-store.ts";
import { startMcpProxy } from "../../services/mcp-proxy/proxy.ts";

void test("Bridge consumes declared commands and callbacks without converting them to model messages", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "iva-screen-mcp-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = pluginRoot(data, "demo");
  await mkdir(root, { recursive: true });
  await mkdir(pluginDataDir(data, "demo"), { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      $schema: PLUGIN_SCHEMA_URL,
      name: "demo",
      extensions: {
        "sh.iva": {
          telegramScreen: { command: "demo", server: "screen", tool: "screen" },
        },
      },
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        screen: {
          type: "stdio",
          command: "node",
          args: [
            fileURLToPath(
              new URL("../fixtures/mcp-screen-server.ts", import.meta.url),
            ),
          ],
        },
      },
    }),
  );
  await writeFile(
    pluginTokenFile(data, "demo", "screen"),
    "screen-test-token",
    { mode: 0o600 },
  );
  const proxy = await startMcpProxy({
    plugin: "demo",
    server: "screen",
    port: 0,
    token: "screen-test-token",
    dataDir: data,
    log: () => {},
  });
  t.after(() => proxy.close());
  await writePluginsState(data, {
    marketplaces: [],
    plugins: [
      {
        name: "demo",
        source: "local",
        ref: "",
        sha: "",
        digest: "",
        enabled: true,
        trusted: true,
        installedAt: "2026-01-01",
        mcp: { screen: { port: proxy.port } },
      },
    ],
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.startsWith("https://api.telegram.org/"))
      return originalFetch(input, init);
    calls.push({
      method: url.split("/").at(-1)!,
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 9 } }),
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  process.env.ASSISTANT_DATA_DIR = data;
  process.env.TELEGRAM_ALLOWED_USER_IDS = "7";
  process.env.TELEGRAM_BOT_TOKEN = "123:test-token";
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({ menuStyle: "rich" }),
  );
  const { handleControl } = await import("./control.ts");
  assert.equal(
    await handleControl({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: "/demo",
        from: { id: 7, is_bot: false },
        chat: { id: 7, type: "private" },
      },
    }),
    true,
  );
  const rich = calls[0].body.rich_message as { markdown: string };
  const callback = /data="([^"]+)"/u.exec(rich.markdown)![1];
  const update = {
    update_id: 2,
    callback_query: {
      id: "cq-test",
      data: callback,
      from: { id: 7, is_bot: false },
      message: { message_id: 9, date: 1, chat: { id: 7, type: "private" } },
    },
  };
  assert.equal(await handleControl(update), true);
  assert.equal(
    "message" in update,
    false,
    "callback never becomes a model message",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["sendRichMessage", "editMessageText", "answerCallbackQuery"],
  );
  assert.equal(
    (calls[1].body.rich_message as { markdown: string }).markdown,
    "Closed",
  );
  assert.equal(
    await handleControl({
      update_id: 3,
      message: {
        message_id: 2,
        date: 1,
        text: "/unknown",
        from: { id: 7, is_bot: false },
        chat: { id: 7, type: "private" },
      },
    }),
    false,
  );
});
