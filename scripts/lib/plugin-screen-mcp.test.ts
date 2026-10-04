import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_SCHEMA_URL, MCP_SCHEMA_URL } from "#lib/plugin-reader.ts";
import { readScreenDeclaration } from "#lib/plugin-screen-declaration.ts";
import {
  pluginRoot,
  pluginDataDir,
  pluginTokenFile,
  writePluginsState,
} from "#lib/plugin-store.ts";
import { startMcpProxy } from "../../services/mcp-proxy/proxy.ts";
import { pluginScreenEndpoints } from "./plugin-screen-mcp.ts";
import { createPluginScreens } from "./plugin-screen.ts";
import fc from "fast-check";

void test("real declared MCP handler opens and closes the same Telegram message through the proxy", async (t) => {
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
  const engine = createPluginScreens({
    dataDir: data,
    endpoints: () => pluginScreenEndpoints(data),
    allowed: (id) => id === 7,
    rich: () => true,
    call: (method, body) => {
      calls.push({ method, body });
      return Promise.resolve({ ok: true, result: { message_id: 9 } });
    },
  });
  assert.equal(await engine.open("/demo", 7, 7, true), true);
  const rich = calls[0].body.rich_message as { markdown: string };
  const callback = /data="([^"]+)"/u.exec(rich.markdown)![1];
  assert.equal(
    await engine.tap({
      data: callback,
      chatId: 7,
      userId: 7,
      messageId: 9,
      privateChat: true,
    }),
    "",
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["sendRichMessage", "editMessageText"],
  );
  assert.equal(
    (calls[1].body.rich_message as { markdown: string }).markdown,
    "Closed",
  );
  await writeFile(join(root, "changed.txt"), "new revision");
  assert.notEqual(
    await engine.tap({
      data: callback,
      chatId: 7,
      userId: 7,
      messageId: 9,
      privateChat: true,
    }),
    "",
  );
});

void test("screen declarations never accept paths or URLs as commands", () => {
  fc.assert(
    fc.property(fc.string(), (command) => {
      const result = readScreenDeclaration({
        "sh.iva": {
          telegramScreen: { command, server: "mcp", tool: "screen" },
        },
      });
      if (result?.success) assert.match(command, /^[a-z][a-z0-9_]{0,31}$/u);
    }),
  );
});
