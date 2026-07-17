import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HEALTH_METRICS_SCHEMA_VERSION = 1;
export const HEALTH_METRICS_MAX_SAMPLES = 24 * 31;
export const HEALTH_METRICS_MAX_AGE_MS = 31 * 24 * 60 * 60_000;
export const HEALTH_METRICS_MIN_INTERVAL_MS = 55 * 60_000;
export const ALERT_BASELINE_MS = 7 * 24 * 60 * 60_000;
export const ALERT_COOLDOWN_MS = 24 * 60 * 60_000;

const metricsPath = (dataDir) => join(dataDir, "health-metrics.jsonl");
const alertPath = (dataDir) => join(dataDir, "health-alert-state.json");
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const isoOrNull = (value) => Number.isFinite(Date.parse(String(value || ""))) ? new Date(value).toISOString() : null;

function privateWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function sanitizeMetricSample(sample) {
  return {
    schemaVersion: HEALTH_METRICS_SCHEMA_VERSION,
    at: new Date(sample.at).toISOString(),
    release: { commit: /^[0-9a-f]{40}$/.test(sample.release?.commit || "") ? sample.release.commit : null },
    services: {
      agentRestarts: finite(sample.services?.agentRestarts), bridgeRestarts: finite(sample.services?.bridgeRestarts),
      rssBytes: finite(sample.services?.rssBytes), peakRssBytes: finite(sample.services?.peakRssBytes),
    },
    workflow: {
      backend: sample.workflow?.backend === "postgres" ? "postgres" : "local",
      storageBytes: finite(sample.workflow?.storageBytes), queueDepth: finite(sample.workflow?.queueDepth),
      oldestActiveAgeSeconds: finite(sample.workflow?.oldestActiveAgeSeconds), active: finite(sample.workflow?.active),
      waiting: finite(sample.workflow?.waiting), retrying: finite(sample.workflow?.retrying), wedged: finite(sample.workflow?.wedged),
    },
    activity: {
      lastSuccessfulTurnAt: isoOrNull(sample.activity?.lastSuccessfulTurnAt),
      memoryAt: isoOrNull(sample.activity?.memoryAt), reminderAt: isoOrNull(sample.activity?.reminderAt),
      backupAt: isoOrNull(sample.activity?.backupAt),
    },
    capacity: {
      freeBytes: finite(sample.capacity?.freeBytes), freePercent: finite(sample.capacity?.freePercent),
      freeInodesPercent: finite(sample.capacity?.freeInodesPercent, 100), swapUsedPercent: finite(sample.capacity?.swapUsedPercent),
    },
  };
}

export function readMetricHistory(dataDir) {
  if (!existsSync(metricsPath(dataDir))) return [];
  return readFileSync(metricsPath(dataDir), "utf8").split(/\r?\n/).flatMap((line) => {
    try {
      const sample = JSON.parse(line);
      return sample.schemaVersion === HEALTH_METRICS_SCHEMA_VERSION && Number.isFinite(Date.parse(sample.at)) ? [sample] : [];
    } catch { return []; }
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function recordMetricSample(dataDir, sample, {
  now = Date.parse(sample.at), minIntervalMs = HEALTH_METRICS_MIN_INTERVAL_MS,
  maxAgeMs = HEALTH_METRICS_MAX_AGE_MS, maxSamples = HEALTH_METRICS_MAX_SAMPLES,
} = {}) {
  const history = readMetricHistory(dataDir);
  const lastAt = Date.parse(history.at(-1)?.at || "");
  if (Number.isFinite(lastAt) && now - lastAt < minIntervalMs) return { recorded: false, history };
  const cutoff = now - maxAgeMs;
  const next = [...history.filter((entry) => Date.parse(entry.at) >= cutoff), sanitizeMetricSample(sample)].slice(-maxSamples);
  privateWrite(metricsPath(dataDir), `${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { recorded: true, history: next };
}

function growth(history, key, windowMs, now) {
  const recent = history.filter((sample) => now - Date.parse(sample.at) <= windowMs);
  if (recent.length < 2) return { bytes: 0, perDay: 0 };
  const first = recent[0], last = recent.at(-1);
  const elapsed = Date.parse(last.at) - Date.parse(first.at);
  const bytes = finite(last.workflow?.[key]) - finite(first.workflow?.[key]);
  return { bytes, perDay: elapsed > 0 ? Math.round(bytes * 86_400_000 / elapsed) : 0 };
}

export function summarizeHealth(history, { now = Date.now() } = {}) {
  if (!history.length) return { available: false, samples: 0, baselineDays: 0, alerts: [] };
  const latest = history.at(-1);
  const spanMs = Math.max(0, Date.parse(latest.at) - Date.parse(history[0].at));
  const growth7d = growth(history, "storageBytes", 7 * 86_400_000, now);
  const growth30d = growth(history, "storageBytes", 30 * 86_400_000, now);
  const growthPerDay = growth7d.perDay || growth30d.perDay;
  const daysUntilFull = growthPerDay > 0 ? latest.capacity.freeBytes / growthPerDay : null;
  return {
    available: true, samples: history.length, latest, baselineDays: Math.floor(spanMs / 86_400_000),
    spanMs, growth7d, growth30d, growthPerDay, daysUntilFull,
  };
}

export function activeHealthAlerts(summary) {
  if (!summary.available || summary.spanMs < ALERT_BASELINE_MS) return [];
  const latest = summary.latest;
  const alerts = [];
  const add = (id, text) => alerts.push({ id, text });
  if (latest.capacity.freeBytes < 1024 ** 3 || latest.capacity.freePercent < 10) add("disk", "Iva: server disk space is low. Run `iva status` and free space.");
  if (latest.capacity.freeInodesPercent < 10) add("inodes", "Iva: filesystem inodes are low. Run `iva status` and inspect small-file growth.");
  if (latest.capacity.swapUsedPercent >= 90) add("swap", "Iva: swap usage is above 90%. Run `iva status` and inspect memory pressure.");
  if (summary.daysUntilFull !== null && summary.growthPerDay >= 10 * 1024 ** 2 && summary.daysUntilFull <= 7) {
    add("workflow-growth", "Iva: Workflow storage growth could fill the disk within 7 days. Run `iva status`; do not delete Workflow tables manually.");
  }
  if (latest.workflow.wedged > 0) add("wedged", "Iva: wedged Workflow runs detected. Run `iva doctor`, then `iva recover` if advised.");
  return alerts;
}

export function readAlertState(dataDir) {
  try {
    const value = JSON.parse(readFileSync(alertPath(dataDir), "utf8"));
    return value.schemaVersion === HEALTH_METRICS_SCHEMA_VERSION && value.alerts && typeof value.alerts === "object" ? value : { schemaVersion: HEALTH_METRICS_SCHEMA_VERSION, alerts: {} };
  } catch { return { schemaVersion: HEALTH_METRICS_SCHEMA_VERSION, alerts: {} }; }
}

export function pendingHealthAlerts(active, state, { now = Date.now(), cooldownMs = ALERT_COOLDOWN_MS } = {}) {
  const activeIds = new Set(active.map((alert) => alert.id));
  const next = { schemaVersion: HEALTH_METRICS_SCHEMA_VERSION, alerts: {} };
  for (const [id, value] of Object.entries(state.alerts || {})) if (activeIds.has(id)) next.alerts[id] = value;
  const pending = active.filter((alert) => now - Date.parse(next.alerts[alert.id]?.notifiedAt || "") >= cooldownMs || !Number.isFinite(Date.parse(next.alerts[alert.id]?.notifiedAt || "")));
  return { pending, state: next };
}

export function markHealthAlertsDelivered(dataDir, state, ids, { now = Date.now() } = {}) {
  for (const id of ids) state.alerts[id] = { notifiedAt: new Date(now).toISOString() };
  privateWrite(alertPath(dataDir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

const size = (bytes) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
const age = (value, now) => value ? `${Math.max(0, Math.round((now - Date.parse(value)) / 3_600_000))}h ago` : "never";

export function formatHealthStatus(summary, { now = Date.now() } = {}) {
  if (!summary.available) return "Observability: no samples yet (the hourly collector has not run).";
  const s = summary.latest;
  const projection = summary.daysUntilFull === null ? "stable" : `${summary.daysUntilFull.toFixed(1)}d to disk limit at current growth`;
  return [
    `Iva status · ${summary.samples} hourly samples · alert baseline ${Math.min(summary.baselineDays, 7)}/7 days · trend ${Math.min(summary.baselineDays, 30)}/30 days`,
    `Services: RSS ${size(s.services.rssBytes)} · peak ${size(s.services.peakRssBytes)} · restarts ${s.services.agentRestarts}/${s.services.bridgeRestarts}`,
    `Workflow (${s.workflow.backend}): ${size(s.workflow.storageBytes)} · ${size(summary.growthPerDay)}/day · ${projection}`,
    `Queue: ${s.workflow.queueDepth} · active ${s.workflow.active} · waiting ${s.workflow.waiting} · wedged ${s.workflow.wedged}${s.workflow.oldestActiveAgeSeconds ? ` · oldest ${Math.round(s.workflow.oldestActiveAgeSeconds / 60)}m` : ""}`,
    `Capacity: disk ${s.capacity.freePercent.toFixed(1)}% (${size(s.capacity.freeBytes)} free) · inodes ${s.capacity.freeInodesPercent.toFixed(1)}% · swap ${s.capacity.swapUsedPercent.toFixed(1)}%`,
    `Last success: turn ${age(s.activity.lastSuccessfulTurnAt, now)} · memory ${age(s.activity.memoryAt, now)} · reminders ${age(s.activity.reminderAt, now)} · backup ${age(s.activity.backupAt, now)}`,
  ].join("\n");
}
