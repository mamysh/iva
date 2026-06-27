import { readFile, writeFile } from "node:fs/promises";
import { Client } from "eve/client";

const mode = process.argv[2];
const host = process.env.SMOKE_HOST ?? "http://127.0.0.1:8724";
const stateFile = process.env.SMOKE_STATE ?? "/tmp/iva-workflow-smoke.json";
const marker = process.env.SMOKE_MARKER ?? "КЕДР-4729";

if (mode !== "seed" && mode !== "resume") {
  console.error("Usage: node scripts/workflow-smoke.mjs <seed|resume>");
  process.exit(2);
}

const client = new Client({ host });
await client.health();

let session;
let prompt;

if (mode === "seed") {
  session = client.session();
  prompt = `Запомни для следующего сообщения код ${marker}. Ответь одним словом: ЗАПОМНИЛА.`;
} else {
  const saved = JSON.parse(await readFile(stateFile, "utf8"));
  session = client.session(saved);
  prompt = "Какой код я попросил запомнить? Ответь только кодом.";
}

const response = await session.send(prompt);
const result = await response.result();

if (result.status === "failed" || !result.message) {
  console.error(`Smoke ${mode} failed: status=${result.status}`);
  process.exit(1);
}

if (mode === "seed") {
  await writeFile(stateFile, `${JSON.stringify(session.state)}\n`, { mode: 0o600 });
} else if (!result.message.includes(marker)) {
  console.error(`Smoke resume lost context: ${result.message}`);
  process.exit(1);
}

console.log(`Smoke ${mode}: status=${result.status}; message=${result.message}`);
process.exit(0);
