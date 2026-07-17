import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeHealthAlerts, formatHealthStatus, markHealthAlertsDelivered, pendingHealthAlerts,
  readAlertState, readMetricHistory, recordMetricSample, summarizeHealth,
} from "./lib/health-metrics.mjs";

const sandbox = mkdtempSync(join(tmpdir(), "iva-health-"));
const hour = 3_600_000;
const now = Date.UTC(2026, 6, 17, 12);

function sample(at, index, overrides = {}) {
  return {
    at: new Date(at).toISOString(),
    services: { agentRestarts: 1, bridgeRestarts: 0, rssBytes: 200 * 1024 ** 2, peakRssBytes: 300 * 1024 ** 2 },
    workflow: {
      backend: "postgres", storageBytes: 100 * 1024 ** 2 + index * 8 * 1024 ** 2, queueDepth: 0,
      oldestActiveAgeSeconds: 0, active: 0, waiting: 0, retrying: 0, wedged: 0,
    },
    activity: { lastSuccessfulTurnAt: new Date(at - hour).toISOString(), memoryAt: null, reminderAt: null, backupAt: null },
    capacity: { freeBytes: 800 * 1024 ** 2, freePercent: 8, freeInodesPercent: 7, swapUsedPercent: 95 },
    ...overrides,
  };
}

try {
  for (let index = 0; index < 40; index++) {
    const at = now - (40 - index) * hour;
    recordMetricSample(sandbox, sample(at, index), { now: at, minIntervalMs: 0, maxAgeMs: 31 * hour, maxSamples: 24 });
  }
  const stored = readMetricHistory(sandbox);
  assert.equal(stored.length, 24, "metric history must obey its fixed sample bound");
  assert.ok(Date.parse(stored[0].at) >= now - 31 * hour);
  assert.equal(statSync(join(sandbox, "health-metrics.jsonl")).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(join(sandbox, "health-metrics.jsonl"), "utf8"), /token|password|\/Users\//i);

  const skipped = recordMetricSample(sandbox, sample(now - 30 * 60_000, 1000), { now: now - 30 * 60_000 });
  assert.equal(skipped.recorded, false, "collector ignored its minimum interval");

  const history = Array.from({ length: 24 * 31 }, (_, index) => sample(now - (24 * 31 - 1 - index) * hour, index));
  assert.ok(history.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)) + 1, 0) < 1024 ** 2, "bounded metrics would exceed 1 MiB");
  const summary = summarizeHealth(history, { now });
  assert.equal(summary.baselineDays, 30);
  assert.ok(summary.growthPerDay > 0);
  assert.ok(summary.daysUntilFull < 7, "runaway growth projection was not detected before disk exhaustion");
  const active = activeHealthAlerts(summary);
  assert.deepEqual(active.map((alert) => alert.id), ["disk", "inodes", "swap", "workflow-growth"]);

  const first = pendingHealthAlerts(active, readAlertState(sandbox), { now });
  assert.equal(first.pending.length, active.length);
  markHealthAlertsDelivered(sandbox, first.state, first.pending.map((alert) => alert.id), { now });
  assert.equal(statSync(join(sandbox, "health-alert-state.json")).mode & 0o777, 0o600);
  const repeated = pendingHealthAlerts(active, readAlertState(sandbox), { now: now + hour });
  assert.equal(repeated.pending.length, 0, "repeated alert was not deduplicated during cooldown");
  const cooled = pendingHealthAlerts(active, readAlertState(sandbox), { now: now + 25 * hour });
  assert.equal(cooled.pending.length, active.length, "active alert did not reappear after cooldown");
  const resolved = pendingHealthAlerts([], readAlertState(sandbox), { now: now + hour });
  assert.deepEqual(resolved.state.alerts, {}, "resolved alert state must not grow forever");

  const shortBaseline = summarizeHealth(history.slice(-24), { now });
  assert.deepEqual(activeHealthAlerts(shortBaseline), [], "alerts must remain disabled during the initial baseline");
  const text = formatHealthStatus(summary, { now });
  assert.match(text, /alert baseline 7\/7 days · trend 30\/30 days/);
  assert.match(text, /Workflow \(postgres\)/);
  assert.doesNotMatch(text, /undefined|NaN|postgresql:\/\//);
  console.log("health metrics checks passed: bounded 31-day history, baseline gate, runaway projection, cooldown and deduplication");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
