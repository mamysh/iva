#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyStorageFailure, classifyWorkflowRun, FAULT_OUTCOMES, recoveryDecision, storageGrowth, summarizeWorkflowRuns } from "./lib/runtime-recovery.mjs";
import { loadBackgroundSession, saveBackgroundSession } from "./lib/background-session.mjs";

const now = Date.parse("2026-07-16T12:00:00Z");
const recent = "2026-07-16T11:59:00Z";
const stale = "2026-07-16T11:00:00Z";

assert.equal(classifyWorkflowRun({ status: "completed" }, { now }), "healthy");
assert.equal(classifyWorkflowRun({ status: "cancelled" }, { now }), "healthy");
assert.equal(classifyWorkflowRun({ status: "failed" }, { now }), "terminal");
assert.equal(classifyWorkflowRun({ status: "running", updatedAt: stale, attributes: { "$eve.type": "session" } }, { now }), "waiting");
assert.equal(classifyWorkflowRun({ status: "running", updatedAt: stale, waitingCount: 1 }, { now }), "waiting");
assert.equal(classifyWorkflowRun({ status: "running", updatedAt: stale, retryingCount: 1 }, { now }), "retrying");
assert.equal(classifyWorkflowRun({ status: "pending", updatedAt: recent }, { now }), "active");
assert.equal(classifyWorkflowRun({ status: "running", updatedAt: stale }, { now }), "wedged");

const summary = summarizeWorkflowRuns([
  { status: "running", updatedAt: stale },
  { status: "running", updatedAt: stale, waitingCount: 1 },
  { status: "failed", updatedAt: recent },
], { now });
assert.deepEqual(summary.states, { healthy: 0, waiting: 1, retrying: 0, terminal: 1, wedged: 1, active: 0 });
assert.equal(summary.oldestActiveAt, new Date(stale).toISOString());

assert.deepEqual(recoveryDecision({ available: false }), { action: "wait", reason: "workflow storage is unavailable" });
assert.equal(recoveryDecision({ available: true, states: {} }, { startLimitHit: true }).action, "cooldown");
assert.equal(recoveryDecision({ available: true, states: { wedged: 1 } }).action, "report");
assert.equal(recoveryDecision({ available: true, states: {} }, { serviceActive: false }).action, "restart");
assert.equal(recoveryDecision({ available: true, states: {} }, { serviceActive: true }).action, "none");
assert.deepEqual(storageGrowth({ at: 0, bytes: 100 }, { at: 3_600_000, bytes: 250 }), { bytes: 150, perHour: 150 });
assert.equal(classifyStorageFailure({ code: "ENOSPC" }), "full");
assert.equal(classifyStorageFailure({ code: "EROFS" }), "unwritable");
assert.equal(classifyStorageFailure({ code: "ECONNREFUSED" }), "unavailable");
assert.equal(classifyStorageFailure(new Error("unexpected")), "unknown");
assert.deepEqual(Object.keys(FAULT_OUTCOMES).sort(), [
  "databaseUnavailable",
  "provider429or500",
  "sigkillAfterDurableStep",
  "sigtermModelStep",
  "storageFull",
  "telegramBridgeStopped",
  "terminalProviderError",
]);

const fixture = await mkdtemp(join(tmpdir(), "iva-background-session-"));
try {
  let resumed;
  const client = { session: (state) => ({ state: state || { sessionId: "stable", streamIndex: 1 } }) };
  const first = await loadBackgroundSession(client, "daily-digest", { env: { ASSISTANT_DATA_DIR: fixture } });
  const path = await saveBackgroundSession(first, "daily-digest", { env: { ASSISTANT_DATA_DIR: fixture } });
  const secondClient = { session: (state) => { resumed = state; return { state }; } };
  await loadBackgroundSession(secondClient, "daily-digest", { env: { ASSISTANT_DATA_DIR: fixture } });
  assert.equal(resumed.sessionId, "stable");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(path, "utf8")).streamIndex, 1);
} finally { await rm(fixture, { recursive: true, force: true }); }

const cli = readFileSync(new URL("../bin/iva.mjs", import.meta.url), "utf8");
const poll = readFileSync(new URL("./telegram-poll.mjs", import.meta.url), "utf8");
const telegramUnit = readFileSync(new URL("../deploy/iva-telegram-poll.service", import.meta.url), "utf8");
const rollup = readFileSync(new URL("./memory/rollup.ts", import.meta.url), "utf8");
const digest = readFileSync(new URL("./daily-digest.ts", import.meta.url), "utf8");
const reminderRunner = readFileSync(new URL("./reminders-run.mjs", import.meta.url), "utf8");
assert.match(cli, /StartLimitIntervalSec=5min/);
assert.match(cli, /Restart=on-failure/);
assert.match(cli, /scripts\/workflow-health\.mjs", "reset/);
assert.match(cli, /scripts\/workflow-health\.mjs", "repair/);
assert.match(cli, /scripts\/workflow-health\.mjs", "reenqueue/);
assert.match(cli, /recover: cmdRecover/);
assert.doesNotMatch(cli, /Full reset/);
assert.match(poll, /return sc\("restart", "iva\.service"\)/);
assert.match(poll, /"reset", "--yes"/);
assert.doesNotMatch(poll, /rm\(WORKFLOW_DIR/);
assert.match(telegramUnit, /StartLimitBurst=5/);
assert.match(telegramUnit, /Restart=on-failure/);
assert.match(rollup, /loadBackgroundSession/);
assert.match(rollup, /memory-rollup-\$\{period\}/);
assert.match(digest, /loadBackgroundSession\(client, "daily-digest"\)/);
assert.match(reminderRunner, /if \(acceptedChunks === 0\) error\.code = "DELIVERY_REJECTED"/);

console.log("runtime recovery checks passed");
