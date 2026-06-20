#!/usr/bin/env node
// Prepare a local checkout + venv for chigwell/telegram-mcp.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "https://github.com/chigwell/telegram-mcp.git";
const DEFAULT_REF = "ae914c05466f52acc269368a36d95bc0c4339bca";

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
const repo = env.TELEGRAM_MCP_REPO || DEFAULT_REPO;
const ref = env.TELEGRAM_MCP_REF || DEFAULT_REF;
const python = env.TELEGRAM_MCP_PYTHON || "python3";
const venvPython = join(mcpDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env }, ...opts });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

mkdirSync(dirname(mcpDir), { recursive: true });

if (!existsSync(join(mcpDir, ".git"))) {
  run("git", ["clone", repo, mcpDir]);
}

run("git", ["fetch", "origin"], { cwd: mcpDir });
run("git", ["checkout", ref], { cwd: mcpDir });

if (!existsSync(venvPython)) {
  run(python, ["-m", "venv", join(mcpDir, ".venv")]);
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], { cwd: mcpDir });
run(venvPython, ["-m", "pip", "install", "-e", "."], { cwd: mcpDir });

console.log(`\ntelegram-mcp is ready in ${mcpDir}`);
console.log("Next: add TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_SESSION_STRING to .env.");
console.log("To create a session string: npm run telegram:mcp:session -- --qr");
