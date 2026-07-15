#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "eve/client";
import { startMockOpenAiServer } from "./lib/mock-openai-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselineMode = process.argv.includes("--baseline");
const jsonMode = process.argv.includes("--json");
const sandbox = await mkdtemp(join(tmpdir(), "iva-replica-"));
const replica = join(sandbox, "app");
const logs = [];
let mock;
let eve;
let resourceReport;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function directorySize(path) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.name.includes(".tmp.")) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) {
      try {
        total += (await stat(full)).size;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return total;
}

function sampleProcess(pid) {
  const output = execFileSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], { encoding: "utf8" }).trim();
  const [rssKiB, cpuPercent] = output.split(/\s+/).map(Number);
  if (!Number.isFinite(rssKiB) || !Number.isFinite(cpuPercent)) throw new Error(`Could not parse ps output: ${output}`);
  return { rssKiB, cpuPercent };
}

function gitMetadata() {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim());
  return { commit, dirty };
}

async function prepareReplica() {
  await mkdir(replica, { recursive: true });
  for (const directory of ["agent", "scripts"]) {
    await cp(join(ROOT, directory), join(replica, directory), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
    await cp(join(ROOT, file), join(replica, file));
  }
  await symlink(join(ROOT, "node_modules"), join(replica, "node_modules"), "dir");
  await mkdir(join(replica, "vault", "cards"), { recursive: true });
  await mkdir(join(replica, "data"), { recursive: true });
}

function replicaEnv(port) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: sandbox,
    NODE_ENV: "development",
    PORT: String(port),
    MODEL_PROVIDER: "ollama",
    OLLAMA_BASE_URL: mock.baseUrl,
    OLLAMA_API_KEY: "synthetic-replica-key",
    OLLAMA_MODEL: "iva-replica",
    OLLAMA_CONTEXT_WINDOW: "131072",
    ASSISTANT_DATA_DIR: join(replica, "data"),
    ASSISTANT_VAULT_DIR: join(replica, "vault"),
    ASSISTANT_TIMEZONE: "UTC",
    MEMORY_SEARCH_MODE: "bm25",
  };
}

async function startEve(port) {
  const child = spawn(
    process.execPath,
    [join(replica, "node_modules/eve/bin/eve.js"), "start", "--host", "127.0.0.1", "--port", String(port)],
    { cwd: replica, env: replicaEnv(port), stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.push(chunk);
      if (logs.length > 80) logs.shift();
    });
  }
  return child;
}

async function buildReplica(port) {
  const child = spawn(
    process.execPath,
    [join(replica, "node_modules/eve/bin/eve.js"), "build"],
    { cwd: replica, env: replicaEnv(port), stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      logs.push(chunk);
      if (logs.length > 80) logs.shift();
    });
  }
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error(`Replica build exited with ${code}\n${logs.join("").slice(-8000)}`);
}

async function waitForHealth(client, child, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Eve exited with ${child.exitCode}\n${logs.join("").slice(-6000)}`);
    try {
      await client.health();
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw new Error(`Eve health timeout: ${lastError}\n${logs.join("").slice(-6000)}`);
}

async function stopEve(child) {
  if (!child) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EPERM") return false;
      throw error;
    }
  };
  if (!signalGroup("SIGTERM")) return;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(100);
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH" || error?.code === "EPERM") return;
      throw error;
    }
  }
  signalGroup("SIGKILL");
}

function assertSuccessfulTurn(result) {
  assert.notEqual(result.status, "failed");
  assert.ok(result.message, `turn returned no message (status=${result.status})`);
}

try {
  await prepareReplica();
  mock = await startMockOpenAiServer();
  const port = await freePort();
  const buildStarted = performance.now();
  await buildReplica(port);
  const buildDurationMs = Math.round(performance.now() - buildStarted);
  const startStarted = performance.now();
  eve = await startEve(port);
  let client = new Client({ host: `http://127.0.0.1:${port}` });
  await waitForHealth(client, eve);
  const startupDurationMs = Math.round(performance.now() - startStarted);

  if (baselineMode) {
    const sizes = {};
    let firstResponseMs;
    for (let turn = 1; turn <= 100; turn++) {
      const turnStarted = performance.now();
      const requestCount = mock.requests.length;
      const turnSession = client.session();
      const result = await (
        await turnSession.send(`Baseline turn ${turn}. Reply with exactly: REPLICA_OK`)
      ).result();
      assertSuccessfulTurn(result);
      assert.equal(result.message.trim(), "REPLICA_OK");
      assert.ok(mock.requests.length > requestCount, `turn ${turn} did not reach the mock provider`);
      if (turn === 1) firstResponseMs = Math.round(performance.now() - turnStarted);
      if ([1, 10, 100].includes(turn)) sizes[String(turn)] = await directorySize(join(replica, ".workflow-data"));
      if (turn % 10 === 0 && turn < 100) {
        await stopEve(eve);
        eve = await startEve(port);
        client = new Client({ host: `http://127.0.0.1:${port}` });
        await waitForHealth(client, eve);
      }
    }
    await sleep(2_000);
    resourceReport = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      source: gitMetadata(),
      fixture: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        storageProfile: "local",
        provider: "loopback-mock",
        turns: 100,
        workload: "10 batches of 10 independent turns with restart between batches",
      },
      timingsMs: { build: buildDurationMs, startup: startupDurationMs, firstResponse: firstResponseMs },
      idle: sampleProcess(eve.pid),
      workflowStateBytes: sizes,
    };
  }

  const textResult = await (await client.session().send("Reply with exactly: REPLICA_OK")).result();
  assertSuccessfulTurn(textResult);
  assert.equal(textResult.message.trim(), "REPLICA_OK");

  const toolResult = await (
    await client.session().send("Use the tasks tool to add the replica canary task, then confirm completion.")
  ).result();
  assertSuccessfulTurn(toolResult);
  assert.equal(toolResult.message.trim(), "TASK_OK");
  const tasks = JSON.parse(await readFile(join(replica, "data", "tasks.json"), "utf8"));
  assert.equal(tasks[0].text, "replica canary task");

  const marker = "CEDAR-4729";
  const remembered = client.session();
  const seed = await (
    await remembered.send(`Remember this code for the next message: ${marker}. Reply with exactly: REMEMBERED.`)
  ).result();
  assertSuccessfulTurn(seed);
  assert.equal(seed.message.trim(), "REMEMBERED");
  const savedState = remembered.state;

  await stopEve(eve);
  eve = await startEve(port);
  client = new Client({ host: `http://127.0.0.1:${port}` });
  await waitForHealth(client, eve);
  const resumed = client.session(savedState);
  const resume = await (
    await resumed.send("What code did I ask you to remember? Reply with the code only.")
  ).result();
  assertSuccessfulTurn(resume);
  assert.equal(resume.message.trim(), marker);

  assert.ok(mock.requests.length >= 5);
  if (jsonMode) {
    console.log(JSON.stringify({
      ok: true,
      canaries: ["text-reply", "model-task-call", "task-persistence", "workflow-restart-resume"],
      resources: resourceReport ?? null,
    }, null, 2));
  } else {
    console.log("replica smoke passed: text reply, model tool call, task persistence, workflow restart/resume");
    if (resourceReport) console.log(JSON.stringify(resourceReport, null, 2));
  }
} catch (error) {
  console.error(error?.stack || String(error));
  if (logs.length) console.error(logs.join("").slice(-8000));
  process.exitCode = 1;
} finally {
  await stopEve(eve);
  if (mock) await mock.close();
  await rm(sandbox, { recursive: true, force: true });
}
