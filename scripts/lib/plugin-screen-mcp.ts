import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readScreenDeclaration } from "#lib/plugin-screen-declaration.ts";
import { pluginTreeDigest, readPlugin } from "#lib/plugin-reader.ts";
import {
  pluginRoot,
  pluginTokenFile,
  readPluginsState,
} from "#lib/plugin-store.ts";
import type { ScreenEndpoint } from "./plugin-screen.ts";

/** Only the existing trusted stdio proxy. The declaration supplies no URL or credentials. */
export async function pluginScreenEndpoints(
  dataDir: string,
): Promise<ScreenEndpoint[]> {
  const entries = (await readPluginsState(dataDir)).plugins;
  const endpoints: ScreenEndpoint[] = [];
  for (const entry of entries) {
    if (!entry.enabled || !entry.trusted) continue;
    const report = await readPlugin(pluginRoot(dataDir, entry.name));
    const parsed = readScreenDeclaration(report.manifest?.extensions ?? {});
    if (!parsed) continue;
    if (!parsed.success) {
      console.error("Invalid plugin screen declaration");
      continue;
    }
    const { command, server } = parsed.data;
    if (report.mcp[server]?.type !== "stdio") {
      console.error("Plugin screen requires a stdio MCP proxy");
      continue;
    }
    const actualDigest = await pluginTreeDigest(
      pluginRoot(dataDir, entry.name),
    );
    const port = entry.mcp?.[server]?.port;
    if (!port) continue;
    endpoints.push({
      plugin: entry.name,
      command: `/${command}`,
      fingerprint: JSON.stringify([
        entry.sha,
        entry.digest,
        actualDigest,
        parsed.data,
      ]),
      async call(event) {
        const token = (
          await readFile(pluginTokenFile(dataDir, entry.name, server), "utf8")
        ).trim();
        const response = await fetch(`http://127.0.0.1:${port}/screen`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ event }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error("Plugin screen handler unavailable");
        const result = z
          .object({
            content: z
              .array(z.object({ type: z.literal("text"), text: z.string() }))
              .length(1),
            isError: z.boolean().optional(),
            structuredContent: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .parse(await response.json());
        if (result.isError) throw new Error("Plugin screen handler failed");
        return (
          result.structuredContent ??
          (JSON.parse(result.content[0].text) as unknown)
        );
      },
    });
  }
  return endpoints;
}
