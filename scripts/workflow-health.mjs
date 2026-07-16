#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld as createLocalWorld } from "@workflow/world-local";
import { createWorld as createPostgresWorld } from "@workflow/world-postgres";
import { Client as EveClient } from "eve/client";
import pg from "pg";
import { resolveRuntimeWorkflowProfile } from "./lib/workflow-runtime.mjs";
import { DEFAULT_WEDGED_AFTER_MS, FAULT_OUTCOMES, RUN_STATE_TRANSITIONS, storageGrowth, summarizeWorkflowRuns } from "./lib/runtime-recovery.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_ENV_PATH = join(ROOT, "deploy/iva-workflow.environment");
const ENV_PATH = join(ROOT, ".env");
const command = process.argv[2] || "status";
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

function runtimeEnvironment() {
  return { ...process.env, ...readEnvFile(PROFILE_ENV_PATH), ...readEnvFile(ENV_PATH), PGCONNECT_TIMEOUT: "5" };
}

function directoryBytes(path) {
  if (!existsSync(path)) return 0;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return total;
}

function readJsonDirectory(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try { return [JSON.parse(readFileSync(join(path, name), "utf8"))]; } catch { return []; }
  });
}

function localExtraMetrics(dataDir, runs) {
  const waits = readJsonDirectory(join(dataDir, "waits")).filter((item) => item.status === "waiting");
  const steps = readJsonDirectory(join(dataDir, "steps"));
  const activeIds = new Set(runs.filter((run) => run.status === "pending" || run.status === "running").map((run) => run.runId));
  const waitingByRun = new Map();
  for (const wait of waits) waitingByRun.set(wait.runId, (waitingByRun.get(wait.runId) || 0) + 1);
  const retryingByRun = new Map();
  for (const step of steps) {
    if (activeIds.has(step.runId) && step.retryAfter && Date.parse(step.retryAfter) > Date.now()) {
      retryingByRun.set(step.runId, (retryingByRun.get(step.runId) || 0) + 1);
    }
  }
  const enriched = runs.map((run) => ({ ...run, waitingCount: waitingByRun.get(run.runId) || 0, retryingCount: retryingByRun.get(run.runId) || 0 }));
  let openStreams = 0;
  for (const mapping of readJsonDirectory(join(dataDir, "streams", "runs"))) {
    for (const stream of mapping.streams || []) {
      const chunkDir = join(dataDir, "streams", "chunks", stream);
      if (!existsSync(chunkDir)) continue;
      const closed = readdirSync(chunkDir).some((name) => {
        try { return readFileSync(join(chunkDir, name))[0] === 1; } catch { return false; }
      });
      if (!closed) openStreams++;
    }
  }
  return { enriched, queueDepth: steps.filter((step) => activeIds.has(step.runId) && ["pending", "running"].includes(step.status)).length, openStreams };
}

async function listAllRuns(world) {
  const runs = [];
  for (const status of ["pending", "running", "completed", "failed", "cancelled"]) {
    let cursor;
    do {
      const page = await world.runs.list({ status, resolveData: "none", pagination: { cursor, limit: 100 } });
      runs.push(...page.data);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return runs;
}

async function localReport(env) {
  const dataDir = resolve(ROOT, env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data");
  const world = createLocalWorld({ dataDir, recoverActiveRuns: false });
  try {
    const runs = await listAllRuns(world);
    const { enriched, queueDepth, openStreams } = localExtraMetrics(dataDir, runs);
    return { backend: "local", available: true, ...summarizeWorkflowRuns(enriched), queueDepth, openStreams, storageBytes: directoryBytes(dataDir), runs: enriched };
  } finally { await world.close(); }
}

async function postgresReport(env) {
  const url = env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL;
  if (!url) throw new Error("WORKFLOW_POSTGRES_URL is not configured");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT r.id AS "runId", r.status, r.attributes, r.created_at AS "createdAt", r.updated_at AS "updatedAt",
        count(DISTINCT w.wait_id) FILTER (WHERE w.status = 'waiting')::int AS "waitingCount",
        count(DISTINCT s.step_id) FILTER (WHERE s.retry_after > now() AND s.status IN ('pending','running'))::int AS "retryingCount"
      FROM workflow.workflow_runs r
      LEFT JOIN workflow.workflow_waits w ON w.run_id = r.id
      LEFT JOIN workflow.workflow_steps s ON s.run_id = r.id
      GROUP BY r.id, r.status, r.attributes, r.created_at, r.updated_at`);
    const queue = await client.query("SELECT count(*)::int AS count FROM graphile_worker.jobs");
    const streams = await client.query(`SELECT count(*)::int AS count FROM (
      SELECT stream_id FROM workflow.workflow_stream_chunks GROUP BY stream_id HAVING NOT bool_or(eof)
    ) open_streams`);
    const size = await client.query(`SELECT coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('workflow', 'graphile_worker') AND c.relkind IN ('r','m')`);
    return { backend: "postgres", available: true, ...summarizeWorkflowRuns(result.rows), queueDepth: queue.rows[0].count, openStreams: streams.rows[0].count, storageBytes: Number(size.rows[0].bytes), runs: result.rows };
  } finally { await client.end(); }
}

async function cancelActive(env, profile) {
  const world = profile.backend === "postgres"
    ? createPostgresWorld({ connectionString: env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL })
    : createLocalWorld({ dataDir: resolve(ROOT, env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data"), recoverActiveRuns: false });
  let cancelled = 0;
  try {
    for (const status of ["pending", "running"]) {
      let cursor;
      do {
        const page = await world.runs.list({ status, resolveData: "none", pagination: { cursor, limit: 100 } });
        for (const run of page.data) {
          await world.events.create(run.runId, { eventType: "run_cancelled", eventData: { cancelReason: "Explicit owner reset via iva reset" } });
          cancelled++;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    }
  } finally { await world.close(); }
  return cancelled;
}

async function repairInterruptedSteps(env, profile) {
  let repaired = 0;
  if (profile.backend === "postgres") {
    const url = env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL;
    if (!url) throw new Error("WORKFLOW_POSTGRES_URL is not configured");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const result = await client.query(`UPDATE workflow.workflow_steps s
        SET status = 'pending', retry_after = now(), updated_at = now()
        FROM workflow.workflow_runs r
        WHERE s.run_id = r.id AND s.status = 'running' AND r.status IN ('pending','running')
        RETURNING s.step_id`);
      repaired = result.rowCount || 0;
    } finally { await client.end(); }
  } else {
    const dataDir = resolve(ROOT, env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data");
    const stepsDir = join(dataDir, "steps");
    if (existsSync(stepsDir)) {
      for (const name of readdirSync(stepsDir).filter((entry) => entry.endsWith(".json"))) {
        const path = join(stepsDir, name);
        let step;
        try { step = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
        if (step.status !== "running") continue;
        step.status = "pending";
        step.retryAfter = new Date().toISOString();
        step.updatedAt = new Date().toISOString();
        const temporary = `${path}.repair-${process.pid}`;
        writeFileSync(temporary, `${JSON.stringify(step)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
        repaired++;
      }
    }
  }
  const world = profile.backend === "postgres"
    ? createPostgresWorld({ connectionString: env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL })
    : createLocalWorld({ dataDir: resolve(ROOT, env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data"), recoverActiveRuns: false });
  let abandoned = 0;
  try {
    for (const status of ["pending", "running"]) {
      let cursor;
      do {
        const page = await world.runs.list({ status, resolveData: "none", pagination: { cursor, limit: 100 } });
        for (const run of page.data) {
          if (run.attributes?.["$eve.type"] === "session") continue;
          await world.events.create(run.runId, { eventType: "run_cancelled", eventData: { cancelReason: "Interrupted turn abandoned by iva recover" } });
          abandoned++;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    }
  } finally { await world.close(); }
  return { repaired, abandoned };
}

async function reenqueueActive(env, profile) {
  const port = env.IVA_PORT || env.PORT || "8723";
  const host = env.ASSISTANT_HOST || `http://127.0.0.1:${port}`;
  const client = new EveClient({ host });
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await client.health(); break; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const world = profile.backend === "postgres"
    ? createPostgresWorld({ connectionString: env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL })
    : createLocalWorld({ dataDir: resolve(ROOT, env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data"), port: Number(port), recoverActiveRuns: true });
  try {
    await world.start?.();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  } finally { await world.close(); }
}

function attachGrowth(report, env) {
  const dataDir = resolve(ROOT, env.ASSISTANT_DATA_DIR || "data");
  const path = join(dataDir, "workflow-health.json");
  let previous;
  try { previous = JSON.parse(readFileSync(path, "utf8")); } catch {}
  const sample = { at: Date.now(), bytes: report.storageBytes };
  report.storageGrowth = storageGrowth(previous, sample);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
  return report;
}

function print(report) {
  if (json) return console.log(JSON.stringify(report));
  if (report.transitions) {
    console.log(`Wedged threshold: ${report.wedgedAfterMs}ms`);
    for (const [state, outcome] of Object.entries(report.transitions)) console.log(`  ${state}: ${outcome}`);
    for (const [fault, outcome] of Object.entries(report.faults || {})) console.log(`  ${fault}: ${outcome}`);
    return;
  }
  console.log(`Workflow (${report.backend}): ${report.available ? "available" : "unavailable"}`);
  if (!report.available) return console.log(`  error: ${report.error}`);
  console.log(`  active ${report.states.active} · waiting ${report.states.waiting} · retrying ${report.states.retrying} · failed ${report.states.terminal} · wedged ${report.states.wedged}`);
  console.log(`  queue ${report.queueDepth} · open streams ${report.openStreams} · storage ${report.storageBytes} bytes`);
  if (report.oldestActiveAt) console.log(`  oldest active: ${report.oldestActiveAt}`);
  if (report.storageGrowth) console.log(`  growth: ${report.storageGrowth.bytes} bytes since previous sample (${report.storageGrowth.perHour}/hour)`);
}

async function main() {
  if (command === "contract") return print({ transitions: RUN_STATE_TRANSITIONS, faults: FAULT_OUTCOMES, wedgedAfterMs: DEFAULT_WEDGED_AFTER_MS });
  const env = runtimeEnvironment();
  const { profile } = resolveRuntimeWorkflowProfile(ROOT, env);
  if (command === "reset") {
    const cancelled = await cancelActive(env, profile);
    return console.log(json ? JSON.stringify({ backend: profile.backend, cancelled }) : `Cancelled ${cancelled} active workflow run(s)`);
  }
  if (command === "repair") {
    const result = await repairInterruptedSteps(env, profile);
    return console.log(json ? JSON.stringify({ backend: profile.backend, ...result }) : `Repaired ${result.repaired} step(s); preserved and abandoned ${result.abandoned} interrupted turn(s)`);
  }
  if (command === "reenqueue") {
    await reenqueueActive(env, profile);
    return console.log(json ? JSON.stringify({ backend: profile.backend, reenqueued: true }) : "Active workflow runs re-enqueued");
  }
  if (command !== "status") throw new Error("Usage: workflow-health.mjs <status|repair|reenqueue|reset|contract> [--json]");
  try {
    const report = attachGrowth(profile.backend === "postgres" ? await postgresReport(env) : await localReport(env), env);
    print(report);
    if (report.states.wedged > 0) process.exitCode = 2;
  } catch (error) {
    print({ backend: profile.backend, available: false, error: String(error.message || error) });
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error.message || error); process.exit(1); });
