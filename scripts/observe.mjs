#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeHealthAlerts, formatHealthStatus, HEALTH_METRICS_MIN_INTERVAL_MS, markHealthAlertsDelivered, pendingHealthAlerts,
  readAlertState, readMetricHistory, recordMetricSample, summarizeHealth,
} from "./lib/health-metrics.mjs";
import { readStateEnvironment } from "./lib/portable-backup.mjs";
import { readEntries } from "./lib/usage.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env, ...readStateEnvironment(ROOT) };
const statePath = (value, fallback) => isAbsolute(value || fallback) ? (value || fallback) : resolve(ROOT, value || fallback);
const dataDir = statePath(env.ASSISTANT_DATA_DIR, "data");
const command = process.argv[2] || "collect";

function cap(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
  return { code: result.status ?? 1, out: String(result.stdout || "").trim() };
}

function systemdValue(unit, property) {
  const value = cap("systemctl", ["--user", "show", unit, `--property=${property}`, "--value"]);
  return value.code === 0 ? value.out : "";
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function unitSuccessAt(unit) {
  if (numberValue(systemdValue(unit, "ExecMainStatus")) !== 0) return null;
  const timestamp = Date.parse(systemdValue(unit, "ExecMainStartTimestamp"));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function swapUsedPercent() {
  try {
    const values = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(SwapTotal|SwapFree):\s+(\d+)/);
      return match ? [[match[1], Number(match[2])]] : [];
    }));
    return values.SwapTotal > 0 ? ((values.SwapTotal - values.SwapFree) / values.SwapTotal) * 100 : 0;
  } catch { return 0; }
}

function processMemory() {
  const pid = numberValue(systemdValue("iva.service", "MainPID"));
  try {
    const values = Object.fromEntries(readFileSync(`/proc/${pid}/status`, "utf8").split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^(VmRSS|VmHWM):\s+(\d+)\s+kB/);
      return match ? [[match[1], Number(match[2]) * 1024]] : [];
    }));
    return { rssBytes: values.VmRSS || 0, peakRssBytes: values.VmHWM || values.VmRSS || 0 };
  } catch { return { rssBytes: 0, peakRssBytes: 0 }; }
}

function backupAt() {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, "backup-state.json"), "utf8"));
    const metadata = JSON.parse(readFileSync(join(state.artifactPath, "backup.json"), "utf8"));
    return metadata.createdAt || null;
  } catch { return null; }
}

function workflowReport() {
  const result = cap(process.execPath, ["scripts/workflow-health.mjs", "status", "--json", "--no-sample"]);
  try { return JSON.parse(result.out); } catch { return { backend: "local", available: false }; }
}

function collectSample(now = Date.now()) {
  const workflow = workflowReport();
  const process = processMemory();
  const disk = statfsSync(existsSync(dataDir) ? dataDir : ROOT);
  const usage = readEntries(dataDir);
  const lastTurn = [...usage].reverse().find((entry) => !entry.error)?.ts || null;
  const oldest = Date.parse(workflow.oldestActiveAt || "");
  return {
    at: new Date(now).toISOString(),
    services: {
      agentRestarts: numberValue(systemdValue("iva.service", "NRestarts")),
      bridgeRestarts: numberValue(systemdValue("iva-telegram-poll.service", "NRestarts")),
      rssBytes: numberValue(systemdValue("iva.service", "MemoryCurrent")) || process.rssBytes,
      peakRssBytes: numberValue(systemdValue("iva.service", "MemoryPeak")) || process.peakRssBytes,
    },
    workflow: {
      backend: workflow.backend, storageBytes: workflow.storageBytes, queueDepth: workflow.queueDepth,
      oldestActiveAgeSeconds: Number.isFinite(oldest) ? Math.max(0, Math.round((now - oldest) / 1000)) : 0,
      active: workflow.states?.active, waiting: workflow.states?.waiting, retrying: workflow.states?.retrying,
      wedged: workflow.states?.wedged,
    },
    activity: {
      lastSuccessfulTurnAt: lastTurn,
      memoryAt: [unitSuccessAt("iva-memory-daily.service"), unitSuccessAt("iva-memory-doctor.service")].filter(Boolean).sort().at(-1) || null,
      reminderAt: unitSuccessAt("iva-reminders.service"), backupAt: backupAt(),
    },
    capacity: {
      freeBytes: disk.bavail * disk.bsize,
      freePercent: disk.blocks > 0 ? disk.bavail / disk.blocks * 100 : 0,
      freeInodesPercent: disk.files > 0 ? disk.ffree / disk.files * 100 : 100,
      swapUsedPercent: swapUsedPercent(),
    },
  };
}

async function sendAlert(text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_DIGEST_CHAT_ID || String(env.TELEGRAM_ALLOWED_USER_IDS || "").split(/[,\s]+/).find(Boolean);
  if (!token || !chat) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(20_000),
    });
    return response.ok;
  } catch { return false; }
}

async function main() {
  if (command === "status") return console.log(formatHealthStatus(summarizeHealth(readMetricHistory(dataDir))));
  if (command !== "collect") throw new Error("Usage: observe.mjs <collect|status>");
  const now = Date.now();
  const previous = readMetricHistory(dataDir);
  const previousAt = Date.parse(previous.at(-1)?.at || "");
  if (Number.isFinite(previousAt) && now - previousAt < HEALTH_METRICS_MIN_INTERVAL_MS) return;
  const result = recordMetricSample(dataDir, collectSample(now), { now });
  if (!result.recorded) return;
  const active = activeHealthAlerts(summarizeHealth(result.history, { now }));
  const planned = pendingHealthAlerts(active, readAlertState(dataDir), { now });
  const delivered = [];
  for (const alert of planned.pending) if (await sendAlert(alert.text)) delivered.push(alert.id);
  markHealthAlertsDelivered(dataDir, planned.state, delivered, { now });
  console.log(`observability sample recorded (${result.history.length}/${24 * 31}); alerts ${delivered.length}`);
}

main().catch((error) => { console.error(`observability: ${error.message || error}`); process.exit(1); });
