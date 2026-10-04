import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { screenEventSchema } from "#lib/plugin-screen-declaration.ts";

const server = new McpServer({ name: "screen-fixture", version: "1" });
server.registerTool(
  "screen",
  { inputSchema: z.object({ event: screenEventSchema }) },
  ({ event }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          event.type === "action" && event.actionId === "close"
            ? { type: "close", markdown: "Closed" }
            : {
                type: "show",
                view: {
                  markdown: event.type === "open" ? "# Home" : "# Next",
                  rows: [[{ id: "close", label: "Close" }]],
                },
              },
        ),
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
