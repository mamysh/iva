export const DEFAULT_WEDGED_AFTER_MS = 15 * 60 * 1000;

export const RUN_STATE_TRANSITIONS = Object.freeze({
  healthy: "terminal completed/cancelled run; no recovery action",
  waiting: "active run with an explicit pending wait; resume when its event or deadline arrives",
  retrying: "active run with a durable retry deadline; retry after provider/storage recovery",
  terminal: "failed run; report the failure and preserve it",
  wedged: "active run older than the threshold with no wait or scheduled retry; report and preserve it",
  active: "recent pending/running run; let the runtime finish or re-enqueue it",
});

export const FAULT_OUTCOMES = Object.freeze({
  sigtermModelStep: "cancel interrupted child turn, preserve its session root, restart and accept the next turn",
  sigkillAfterDurableStep: "preserve the completed side effect once, cancel the interrupted child turn, restart and accept the next turn",
  databaseUnavailable: "report storage unavailable without mutation; return after connectivity is restored",
  provider429or500: "retry with the runtime policy and complete without owner intervention",
  terminalProviderError: "record one terminal run and do not retry it",
  storageFull: "report storage full, stop recovery mutation and wait for capacity to be restored",
  telegramBridgeStopped: "keep Eve available; restart the bridge independently",
});

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function classifyWorkflowRun(run, { now = Date.now(), wedgedAfterMs = DEFAULT_WEDGED_AFTER_MS } = {}) {
  if (run.status === "completed" || run.status === "cancelled") return "healthy";
  if (run.status === "failed") return "terminal";
  if (run.status === "running" && run.attributes?.["$eve.type"] === "session") return "waiting";
  if (Number(run.waitingCount || 0) > 0) return "waiting";
  if (Number(run.retryingCount || 0) > 0) return "retrying";
  if (run.status === "pending" || run.status === "running") {
    const updatedAt = timestamp(run.updatedAt || run.createdAt);
    return updatedAt > 0 && now - updatedAt >= wedgedAfterMs ? "wedged" : "active";
  }
  return "terminal";
}

export function summarizeWorkflowRuns(runs, options = {}) {
  const states = { healthy: 0, waiting: 0, retrying: 0, terminal: 0, wedged: 0, active: 0 };
  let oldestActiveAt;
  for (const run of runs) {
    const state = classifyWorkflowRun(run, options);
    states[state]++;
    if (["active", "waiting", "retrying", "wedged"].includes(state)) {
      const value = timestamp(run.updatedAt || run.createdAt);
      if (value && (!oldestActiveAt || value < oldestActiveAt)) oldestActiveAt = value;
    }
  }
  return { states, oldestActiveAt: oldestActiveAt ? new Date(oldestActiveAt).toISOString() : null };
}

export function recoveryDecision(report, { serviceActive = false, startLimitHit = false } = {}) {
  if (!report.available) return { action: "wait", reason: "workflow storage is unavailable" };
  if (startLimitHit) return { action: "cooldown", reason: "systemd restart limit is active" };
  if ((report.states?.wedged || 0) > 0) {
    return { action: "report", reason: "wedged runs require explicit reset; recover will not delete them" };
  }
  if (serviceActive) return { action: "none", reason: "runtime and workflow storage are healthy" };
  return { action: "restart", reason: "storage is ready and the runtime is inactive" };
}

export function storageGrowth(previous, current) {
  if (!previous || !Number.isFinite(previous.bytes) || !Number.isFinite(previous.at)) return null;
  const elapsedMs = current.at - previous.at;
  if (elapsedMs <= 0) return null;
  return { bytes: current.bytes - previous.bytes, perHour: Math.round(((current.bytes - previous.bytes) * 3_600_000) / elapsedMs) };
}

export function classifyStorageFailure(error) {
  const code = String(error?.code || "").toUpperCase();
  if (code === "ENOSPC") return "full";
  if (code === "EROFS" || code === "EACCES") return "unwritable";
  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"].includes(code)) return "unavailable";
  return "unknown";
}
