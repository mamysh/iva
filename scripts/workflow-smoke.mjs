#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "eve/client";

const mode = process.argv[2];
const port = process.env.IVA_PORT ?? "8723";
const host = process.env.SMOKE_HOST ?? process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${port}`;
const stateFile = process.env.SMOKE_STATE ?? "/tmp/iva-workflow-smoke.json";
const marker = process.env.SMOKE_MARKER ?? "CEDAR-4729";

if (mode !== "seed" && mode !== "resume") {
  console.error("Usage: npm run workflow:smoke -- <seed|resume>");
  process.exit(2);
}

const client = new Client({ host });
await client.health();

let session;
let prompt;

if (mode === "seed") {
  session = client.session();
  prompt = `Remember this code for the next message: ${marker}. Reply with exactly: REMEMBERED.`;
} else {
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  session = client.session(saved);
  prompt = "What code did I ask you to remember? Reply with the code only.";
}

const response = await session.send(prompt);
const result = await response.result();

if (result.status === "failed" || !result.message) {
  console.error(`Workflow smoke ${mode} failed: status=${result.status}`);
  process.exit(1);
}

if (mode === "seed") {
  await writeFile(stateFile, `${JSON.stringify(session.state)}\n`, { mode: 0o600 });
} else if (!result.message.includes(marker)) {
  console.error(`Workflow smoke resume lost context: ${result.message}`);
  process.exit(1);
}

console.log(`Workflow smoke ${mode}: status=${result.status}; message=${result.message}`);
