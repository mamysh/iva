#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client as EveClient } from "eve/client";
import pg from "pg";
import { assertWorkflowProfileMatch } from "./lib/workflow-config.mjs";
import { readWorkflowBuildDescriptor, resolveRuntimeWorkflowProfile } from "./lib/workflow-runtime.mjs";
import { evaluateDoctorSnapshot, formatDoctorReport } from "./lib/doctor-contract.mjs";
import { readEntries } from "./lib/usage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const PROFILE_ENV_PATH = join(ROOT, "deploy/iva-workflow.environment");
const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const TIMERS = ["daily", "weekly", "monthly", "yearly", "doctor"].map((name) => `iva-memory-${name}.timer`).concat("iva-reminders.timer");
const json = process.argv.includes("--json");

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = { ...process.env, ...readEnvFile(PROFILE_ENV_PATH), ...readEnvFile(ENV_PATH) };
const dataDir = resolvePath(env.ASSISTANT_DATA_DIR || "data");
const vaultDir = resolvePath(env.ASSISTANT_VAULT_DIR || "vault");

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    cwd: options.cwd || ROOT,
    env: options.env || env,
    encoding: "utf8",
    timeout: options.timeout || 10_000,
    input: options.input,
  });
  return { code: result.status ?? 1, out: String(result.stdout || "").trim(), err: String(result.stderr || "").trim() };
}

function systemdValue(unit, property) {
  return command("systemctl", ["--user", "show", unit, `--property=${property}`, "--value"]).out;
}

function serviceSnapshot(systemd, name) {
  if (!systemd) return { active: false, restarts: 0 };
  return {
    active: command("systemctl", ["--user", "is-active", "--quiet", name]).code === 0,
    restarts: Number.parseInt(systemdValue(name, "NRestarts"), 10) || 0,
  };
}

function lastSuccessfulUnitRun(name) {
  if (command("systemctl", ["--user", "show-environment"]).code !== 0) return null;
  if (Number.parseInt(systemdValue(name, "ExecMainStatus"), 10) !== 0) return null;
  const value = systemdValue(name, "ExecMainStartTimestamp");
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

async function healthOk() {
  const host = env.ASSISTANT_HOST || `http://127.0.0.1:${env.IVA_PORT || "8723"}`;
  const client = new EveClient({ host });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await Promise.race([
        client.health(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3_000)),
      ]);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

function configurationSnapshot() {
  const provider = (env.MODEL_PROVIDER || "ollama").trim().toLowerCase();
  const providerKeys = {
    ollama: ["OLLAMA_API_KEY", "OLLAMA_MODEL"], opencode: ["OPENCODE_API_KEY", "OPENCODE_MODEL"],
    openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"], codex: ["CODEX_MODEL"],
  };
  const required = [...(providerKeys[provider] || providerKeys.ollama), "DEEPGRAM_API_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USER_IDS"];
  const providerConfigured = (providerKeys[provider] || providerKeys.ollama).every((key) => Boolean(String(env[key] || "").trim())) &&
    (provider !== "codex" || existsSync(join(dataDir, "codex-auth.json")));
  const searchProvider = (env.SEARCH_PROVIDER || "tavily").trim().toLowerCase();
  const searchKey = { tavily: "TAVILY_API_KEY", brave: "BRAVE_API_KEY", exa: "EXA_API_KEY", parallel: "PARALLEL_API_KEY" }[searchProvider] || "TAVILY_API_KEY";
  const memoryMode = (env.MEMORY_SEARCH_MODE || "grep").trim().toLowerCase();
  return {
    nodeSupported: Number(process.versions.node.split(".")[0]) >= 24,
    nodeMajor: Number(process.versions.node.split(".")[0]),
    required: existsSync(ENV_PATH) && required.every((key) => Boolean(String(env[key] || "").trim())) && providerConfigured,
    provider, providerConfigured, search: Boolean(String(env[searchKey] || "").trim()), searchProvider,
    memory: memoryMode !== "hybrid" || Boolean(String(env.JINA_API_KEY || env.DEEPINFRA_API_KEY || "").trim()), memoryMode,
  };
}

function buildSnapshot() {
  let profile = "unknown";
  let profileMatch = false;
  try {
    const resolved = resolveRuntimeWorkflowProfile(ROOT, env).profile;
    profile = resolved.backend;
    assertWorkflowProfileMatch(readWorkflowBuildDescriptor(ROOT), resolved);
    profileMatch = true;
  } catch {}
  return { present: existsSync(join(ROOT, ".output/server/index.mjs")), profileMatch, profile };
}

function countFiles(path) {
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(path, entry.name)) : 1;
  }
  return count;
}

async function storageProbe(backend) {
  if (backend === "postgres") {
    const url = env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL;
    if (!url) return { writeRead: false, chunks: 0 };
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE iva_doctor_probe (value integer) ON COMMIT DROP");
      await client.query("INSERT INTO iva_doctor_probe VALUES (1)");
      const probe = await client.query("SELECT value FROM iva_doctor_probe");
      const chunks = await client.query("SELECT count(*)::int AS count FROM workflow.workflow_stream_chunks");
      await client.query("ROLLBACK");
      return { writeRead: probe.rows[0]?.value === 1, chunks: chunks.rows[0]?.count || 0 };
    } catch {
      try { await client.query("ROLLBACK"); } catch {}
      return { writeRead: false, chunks: 0 };
    } finally { await client.end().catch(() => {}); }
  }
  const workflowDir = resolvePath(env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data");
  const probe = join(workflowDir, `.iva-doctor-probe-${process.pid}`);
  try {
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(probe, "iva-doctor", { mode: 0o600 });
    const ok = readFileSync(probe, "utf8") === "iva-doctor";
    rmSync(probe, { force: true });
    return { writeRead: ok, chunks: countFiles(join(workflowDir, "streams/chunks")) };
  } catch {
    rmSync(probe, { force: true });
    return { writeRead: false, chunks: 0 };
  }
}

async function workflowSnapshot() {
  let backend = "unknown";
  try { backend = resolveRuntimeWorkflowProfile(ROOT, env).profile.backend; } catch {}
  const result = command(process.execPath, ["scripts/workflow-health.mjs", "status", "--json", "--no-sample"], { timeout: 20_000 });
  let report = {};
  try { report = JSON.parse(result.out); } catch {}
  const probe = await storageProbe(backend);
  const schemaCurrent = backend === "postgres"
    ? command(process.execPath, ["scripts/postgres-profile.mjs", "check"], { timeout: 20_000 }).code === 0
    : Boolean(report.available);
  const growthPerHour = Number(report.storageGrowth?.perHour || 0);
  const storageBytes = Number(report.storageBytes || 0);
  return {
    backend, available: Boolean(report.available), schemaCurrent, ...probe,
    active: Number(report.states?.active || 0), waiting: Number(report.states?.waiting || 0),
    retrying: Number(report.states?.retrying || 0), failed: Number(report.states?.terminal || 0),
    wedged: Number(report.states?.wedged || 0), queue: Number(report.queueDepth || 0), openStreams: Number(report.openStreams || 0),
    storageBytes, growthPerHour, runawayGrowth: growthPerHour > Math.max(50 * 1024 * 1024, storageBytes / 2),
  };
}

function newestVerifiedDatabaseBackup() {
  if (!existsSync(join(dataDir, "backups"))) return false;
  const dumps = readdirSync(join(dataDir, "backups"))
    .filter((name) => name.endsWith(".dump"))
    .map((name) => join(dataDir, "backups", name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!dumps.length || statSync(dumps[0]).size === 0) return false;
  return command("pg_restore", ["-l", dumps[0]], { timeout: 15_000 }).code === 0;
}

const configuration = configurationSnapshot();
const build = buildSnapshot();
const systemd = command("systemctl", ["--user", "show-environment"]).code === 0;
const agent = serviceSnapshot(systemd, SERVICES[0]);
const bridge = serviceSnapshot(systemd, SERVICES[1]);
const timersEnabled = systemd ? TIMERS.filter((name) => command("systemctl", ["--user", "is-enabled", "--quiet", name]).code === 0).length : 0;
const workflow = await workflowSnapshot();
const usage = readEntries(dataDir);
const providerLastSuccess = [...usage].reverse().find((entry) => !entry.error)?.ts || null;
const memoryJobTimes = ["iva-memory-daily.service", "iva-memory-doctor.service"].map(lastSuccessfulUnitRun).filter(Boolean).sort();
const memoryLastSuccess = memoryJobTimes.at(-1) || null;
const reminderLastSuccess = lastSuccessfulUnitRun("iva-reminders.service");
const vaultRemote = existsSync(vaultDir) && command("git", ["-C", vaultDir, "remote", "get-url", "origin"]).code === 0;
const indexPath = join(vaultDir, ".index/embeddings.json");
const indexReady = configuration.memoryMode !== "hybrid" || (existsSync(indexPath) && Date.now() - statSync(indexPath).mtimeMs <= 48 * 3_600_000);
const disk = statfsSync(existsSync(dataDir) ? dataDir : ROOT);
const fixed = String(process.env.IVA_DOCTOR_FIXED || "").split(",").filter(Boolean);

const report = evaluateDoctorSnapshot({
  configuration,
  build,
  services: {
    systemd, agentActive: agent.active, bridgeActive: bridge.active, agentRestarts: agent.restarts, bridgeRestarts: bridge.restarts,
    health: await healthOk(), timersReady: timersEnabled === TIMERS.length, timersEnabled, timersExpected: TIMERS.length,
  },
  workflow,
  telegram: { configured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ALLOWED_USER_IDS), bridgeReady: bridge.active },
  provider: { configured: configuration.providerConfigured, name: configuration.provider, lastSuccessAt: providerLastSuccess },
  memory: { lastJobSuccessAt: memoryLastSuccess, vault: existsSync(vaultDir), indexReady },
  backups: {
    lastReminderDispatchAt: reminderLastSuccess,
    vaultRemote,
    lastVaultBackupAt: lastSuccessfulUnitRun("iva-memory-doctor.service"),
    databaseBackup: workflow.backend === "postgres" ? newestVerifiedDatabaseBackup() : true,
  },
  capacity: { freeBytes: disk.bavail * disk.bsize, freePercent: Math.round((disk.bavail / disk.blocks) * 100) },
}, { fixed });

console.log(json ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
process.exit(report.exitCode);
