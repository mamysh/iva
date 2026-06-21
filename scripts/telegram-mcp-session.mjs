#!/usr/bin/env node
// Run chigwell/telegram-mcp's session_string_generator.py from the project venv.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    let value = rest.join("=").trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && [`"`, `'`].includes(value[0])) {
      value = value.slice(1, -1);
    }
    env[key.trim()] = value;
  }
  return env;
}

const envFile = readEnvFile(join(ROOT, ".env"));
const env = { ...envFile, ...process.env };
const projectPath = (value) => (isAbsolute(value) ? value : join(ROOT, value));
const dataDir = projectPath(env.ASSISTANT_DATA_DIR || "data");
const mcpDir = projectPath(env.TELEGRAM_MCP_DIR || join(dataDir, "telegram-mcp"));
const venvPython = join(mcpDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

if (!existsSync(venvPython)) {
  console.error("telegram-mcp venv not found. Run `npm run telegram:mcp:setup` first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const generator = join(mcpDir, "session_string_generator.py");

if (!existsSync(generator)) {
  console.error(`telegram-mcp session generator not found: ${generator}`);
  process.exit(1);
}

const res = spawnSync(venvPython, [generator, ...args], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, ...env },
});
process.exit(res.status ?? 1);
