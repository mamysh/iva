#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "eve/client";
import { startMockOpenAiServer } from "./lib/mock-openai-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "iva-clean-install-"));
const app = join(sandbox, "app");
const home = join(sandbox, "home");
const state = join(sandbox, "state");
const stubs = join(sandbox, "bin");
const processState = join(sandbox, "processes");
const preload = join(sandbox, "telegram-fetch-preload.mjs");
const serviceControl = join(sandbox, "service-control.mjs");
const realNpm = process.env.npm_execpath;
const logs = [];
let provider;
let telegramServer;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function executable(path, body) {
  await writeFile(path, body, { mode: 0o755 });
}

async function copyFixture() {
  await mkdir(app, { recursive: true });
  for (const name of ["agent", "bin", "deploy", "patches", "scripts", "services", "vault-template"]) {
    await cp(join(ROOT, name), join(app, name), { recursive: true });
  }
  for (const name of ["install.sh", "package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(ROOT, name), join(app, name));
  }
}

async function startTelegramMock() {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const method = new URL(request.url, "http://127.0.0.1").pathname.split("/").pop();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: method === "getUpdates" ? [] : true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function writeStubs(port, telegramBaseUrl) {
  await mkdir(stubs, { recursive: true });
  await mkdir(processState, { recursive: true });
  await writeFile(
    preload,
    `const realFetch = globalThis.fetch;\n` +
      `globalThis.fetch = (input, init) => realFetch(String(input).replace("https://api.telegram.org", ${JSON.stringify(telegramBaseUrl)}), init);\n`,
  );
  await writeFile(
    serviceControl,
    `import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [action, unit] = process.argv.slice(2);
const app = process.env.IVA_FIXTURE_APP;
const state = process.env.IVA_FIXTURE_STATE;
const pidfile = join(state, unit + ".pid");
const logfile = join(state, unit + ".log");
const running = () => {
  if (!existsSync(pidfile)) return false;
  try { process.kill(Number(readFileSync(pidfile, "utf8")), 0); return true; } catch { return false; }
};
const stop = () => {
  if (!running()) { rmSync(pidfile, { force: true }); return; }
  try { process.kill(Number(readFileSync(pidfile, "utf8")), "SIGTERM"); } catch {}
  rmSync(pidfile, { force: true });
};
const start = () => {
  if (running()) return;
  const common = ["--env-file=.env"];
  const args = unit === "iva.service"
    ? [...common, "scripts/start.mjs", "--host", "127.0.0.1", "--port", process.env.IVA_FIXTURE_PORT]
    : [...common, "--import", process.env.IVA_FIXTURE_PRELOAD, "scripts/telegram-poll.mjs"];
  const log = openSync(logfile, "a");
  const child = spawn(process.env.IVA_FIXTURE_NODE, args, {
    cwd: app,
    env: process.env,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  writeFileSync(pidfile, String(child.pid));
};
if (action === "restart") { stop(); start(); }
else if (action === "status") process.exit(running() ? 0 : 1);
else if (action === "stop") stop();
`,
  );

  assert.ok(realNpm, "real npm not found");
  await executable(
    join(stubs, "npm"),
    "#!/usr/bin/env bash\n" +
      "if [ \"${1:-}\" = i ] && [ \"${2:-}\" = -g ]; then exit 1; fi\n" +
      "exec \"$IVA_FIXTURE_REAL_NODE\" \"$IVA_FIXTURE_REAL_NPM\" \"$@\"\n",
  );
  for (const command of ["gh", "uv", "ffmpeg", "pandoc", "pdftotext"]) {
    await executable(join(stubs, command), `#!/usr/bin/env bash\nexit 0\n`);
  }
  await executable(join(stubs, "journalctl"), "#!/usr/bin/env bash\nexit 0\n");
  await executable(join(stubs, "loginctl"), "#!/usr/bin/env bash\nexit 0\n");

  await executable(
    join(stubs, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --user ]; then shift; fi
action="\${1:-}"; shift || true
case "$action" in
  show-environment|daemon-reload|reset-failed) exit 0 ;;
  enable) exit 0 ;;
  restart) for unit in "$@"; do "\${IVA_FIXTURE_NODE}" "\${IVA_FIXTURE_CONTROL}" restart "$unit"; done ;;
  is-active)
    [ "\${1:-}" = --quiet ] && shift
    "\${IVA_FIXTURE_NODE}" "\${IVA_FIXTURE_CONTROL}" status "\${1:-}"
    ;;
  is-enabled) exit 0 ;;
  show) echo 0 ;;
  *) exit 0 ;;
esac
`,
  );
}

async function runInstaller() {
  const child = spawn("bash", ["install.sh", "--skip-setup"], {
    cwd: app,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: state,
      PATH: `${stubs}:${process.env.PATH || ""}`,
      IVA_FIXTURE_APP: app,
      IVA_FIXTURE_NODE: process.execPath,
      IVA_FIXTURE_REAL_NODE: process.execPath,
      IVA_FIXTURE_REAL_NPM: realNpm,
      IVA_INSTALL_SKIP_OPTIONAL: "true",
      IVA_FIXTURE_PORT: String(process.env.IVA_FIXTURE_PORT),
      IVA_FIXTURE_PRELOAD: preload,
      IVA_FIXTURE_CONTROL: serviceControl,
      IVA_FIXTURE_STATE: processState,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.push(chunk);
      if (logs.length > 200) logs.shift();
    });
  }
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("installer timed out")), 10 * 60_000);
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });
  assert.equal(code, 0, logs.join("").slice(-10_000));
  assert.match(logs.join(""), /Iva is ready/);
}

async function stopFixtureProcesses() {
  for (const unit of ["iva.service", "iva-telegram-poll.service"]) {
    try {
      const pid = Number((await readFile(join(processState, `${unit}.pid`), "utf8")).trim());
      if (pid) process.kill(pid, "SIGTERM");
    } catch {}
  }
  await sleep(200);
}

async function controlService(action, unit) {
  const child = spawn(process.execPath, [serviceControl, action, unit], {
    cwd: app,
    env: {
      ...process.env,
      IVA_FIXTURE_APP: app,
      IVA_FIXTURE_NODE: process.execPath,
      IVA_FIXTURE_PORT: process.env.IVA_FIXTURE_PORT,
      IVA_FIXTURE_PRELOAD: preload,
      IVA_FIXTURE_STATE: processState,
    },
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, `${action} ${unit} failed`);
}

async function runFixtureCli(args) {
  const child = spawn(process.execPath, [join(app, "bin/iva.mjs"), ...args], {
    cwd: app,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: state,
      PATH: `${stubs}:${process.env.PATH || ""}`,
      IVA_FIXTURE_APP: app,
      IVA_FIXTURE_NODE: process.execPath,
      IVA_FIXTURE_PORT: process.env.IVA_FIXTURE_PORT,
      IVA_FIXTURE_PRELOAD: preload,
      IVA_FIXTURE_CONTROL: serviceControl,
      IVA_FIXTURE_STATE: processState,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  return { code, output };
}

try {
  await mkdir(home, { recursive: true });
  await copyFixture();
  provider = await startMockOpenAiServer();
  const telegram = await startTelegramMock();
  telegramServer = telegram;
  const port = await freePort();
  process.env.IVA_FIXTURE_PORT = String(port);
  await writeStubs(port, telegram.baseUrl);

  await writeFile(
    join(app, ".env"),
    [
      "MODEL_PROVIDER=ollama",
      `OLLAMA_BASE_URL=${provider.baseUrl}`,
      "OLLAMA_API_KEY=synthetic-install-key",
      "OLLAMA_MODEL=iva-install-fixture",
      "DEEPGRAM_API_KEY=synthetic-deepgram-key",
      "TELEGRAM_BOT_TOKEN=123456:synthetic-token",
      "TELEGRAM_ALLOWED_USER_IDS=1000",
      "TELEGRAM_WEBHOOK_SECRET_TOKEN=synthetic-webhook-secret",
      `ASSISTANT_HOST=http://127.0.0.1:${port}`,
      `IVA_PORT=${port}`,
      `ASSISTANT_DATA_DIR=${join(sandbox, "data")}`,
      `ASSISTANT_VAULT_DIR=${join(sandbox, "vault")}`,
      "ASSISTANT_TIMEZONE=UTC",
      "MEMORY_SEARCH_MODE=bm25",
      "AGENT_LANGUAGE=en",
    ].join("\n") + "\n",
    { mode: 0o644 },
  );
  await writeFile(join(app, "deploy", "iva-workflow.environment"), "WORKFLOW_TARGET_WORLD=local\n", { mode: 0o644 });

  await runInstaller();
  const firstReply = await (await new Client({ host: `http://127.0.0.1:${port}` }).session().send("Reply exactly: INSTALL_OK")).result();
  assert.match(JSON.stringify(firstReply), /INSTALL_OK/);
  await controlService("stop", "iva.service");
  const repairedDoctor = await runFixtureCli(["doctor"]);
  assert.equal(repairedDoctor.code, 0, repairedDoctor.output);
  assert.match(repairedDoctor.output, /fixed: 1/);
  await controlService("status", "iva.service");
  const jsonDoctor = await runFixtureCli(["doctor", "--json"]);
  assert.equal(jsonDoctor.code, 0, jsonDoctor.output);
  const doctorReport = JSON.parse(jsonDoctor.output);
  assert.equal(doctorReport.exitCode, 0);
  assert.equal(doctorReport.checks.find((item) => item.id === "services.agent")?.status, "pass");
  assert.doesNotMatch(jsonDoctor.output, /synthetic-install-key|synthetic-token|1000|\/iva-clean-install-/);
  assert.ok(telegram.requests() > 0, "Telegram polling bridge did not reach the mock Bot API");
  await controlService("stop", "iva-telegram-poll.service");
  const whileBridgeStopped = await (await new Client({ host: `http://127.0.0.1:${port}` }).session().send("Reply exactly: INSTALL_OK")).result();
  assert.match(JSON.stringify(whileBridgeStopped), /INSTALL_OK/, "Eve failed when only the Telegram bridge was stopped");
  const telegramBeforeRestart = telegram.requests();
  await controlService("restart", "iva-telegram-poll.service");
  const bridgeDeadline = Date.now() + 5_000;
  while (telegram.requests() <= telegramBeforeRestart && Date.now() < bridgeDeadline) await sleep(50);
  assert.ok(telegram.requests() > telegramBeforeRestart, "Telegram bridge did not recover independently");

  const sentinel = join(sandbox, "vault", "sentinel.txt");
  await writeFile(sentinel, "preserve me\n");
  await runInstaller();
  assert.equal(await readFile(sentinel, "utf8"), "preserve me\n");

  const reportPath = join(state, "iva", "install-state.jsonl");
  const report = (await readFile(reportPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const runs = new Map();
  for (const entry of report) {
    if (!runs.has(entry.run)) runs.set(entry.run, []);
    runs.get(entry.run).push(entry);
  }
  assert.equal(runs.size, 2);
  for (const entries of runs.values()) {
    assert.ok(entries.some((entry) => entry.stage === "readiness" && entry.status === "completed"));
  }
  for (const path of [join(app, ".env"), join(app, "deploy", "iva-workflow.environment"), reportPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, `${basename(path)} must be 0600`);
  }

  console.log("clean install smoke passed: ready, doctor auto-fix, redacted JSON, independent bridge recovery, 0600 secrets, idempotent rerun");
} finally {
  await stopFixtureProcesses();
  await telegramServer?.close();
  await provider?.close();
  await rm(sandbox, { recursive: true, force: true });
}
