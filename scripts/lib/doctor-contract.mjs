export const DOCTOR_SCHEMA_VERSION = 1;
export const DOCTOR_COMPONENTS = Object.freeze([
  "configuration",
  "build",
  "services",
  "workflow",
  "telegram",
  "provider",
  "memory",
  "backups",
  "capacity",
]);

const SECRET_KEY = /(?:token|secret|password|api[_-]?key|authorization|connection[_-]?string|database[_-]?url|chat[_-]?id|user[_-]?id|allowed[_-]?user)/i;
const PRIVATE_VALUE = /(?:postgres(?:ql)?:\/\/|https?:\/\/[^\s]+@|\/Users\/|\/home\/|\/root\/|bot\d{6,}:|BEGIN (?:RSA|OPENSSH) PRIVATE KEY)/i;

function ageHours(value, now) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? Math.max(0, Math.round((now - timestamp) / 3_600_000)) : null;
}

function fix(kind, command = null) {
  return { kind, ...(command ? { command } : {}) };
}

function check(id, component, status, options = {}) {
  return {
    id,
    component,
    status,
    severity: options.severity || (status === "pass" || status === "fixed" ? "info" : "warning"),
    blocksReplies: Boolean(options.blocksReplies),
    evidence: options.evidence || {},
    summary: options.summary,
    fix: options.fix || fix("none"),
  };
}

export function evaluateDoctorSnapshot(snapshot, { now = Date.now(), fixed = [] } = {}) {
  const checks = [];
  const fixedSet = new Set(fixed);
  const add = (id, component, ok, options = {}) => checks.push(check(
    id,
    component,
    ok ? (fixedSet.has(id) ? "fixed" : "pass") : options.failureStatus || "fail",
    ok ? {
      ...options,
      summary: options.passSummary || `${id} passed`,
      severity: "info",
      blocksReplies: false,
      fix: fix("none"),
    } : options,
  ));

  add("configuration.node", "configuration", Boolean(snapshot.configuration?.nodeSupported), {
    severity: "critical", blocksReplies: true, summary: "Node.js 24 or newer is required",
    evidence: { major: Number(snapshot.configuration?.nodeMajor || 0) }, fix: fix("manual", "nvm install 24"),
  });

  add("configuration.required", "configuration", Boolean(snapshot.configuration?.required), {
    severity: "critical", blocksReplies: true, summary: "Required configuration is incomplete",
    evidence: { provider: snapshot.configuration?.provider || "unknown" }, fix: fix("manual", "iva config"),
  });
  add("configuration.search", "configuration", Boolean(snapshot.configuration?.search), {
    failureStatus: "warn", severity: "warning", summary: "Web search provider is not configured",
    evidence: { provider: snapshot.configuration?.searchProvider || "unknown" }, fix: fix("manual", "iva config"),
  });
  add("configuration.memory", "configuration", Boolean(snapshot.configuration?.memory), {
    failureStatus: "warn", severity: "warning", summary: "Hybrid memory has no embedding provider",
    evidence: { mode: snapshot.configuration?.memoryMode || "unknown" }, fix: fix("manual", "iva config"),
  });

  add("build.output", "build", Boolean(snapshot.build?.present), {
    severity: "critical", blocksReplies: true, summary: "Production build is missing",
    evidence: { present: Boolean(snapshot.build?.present) }, fix: fix("automatic", "npm run build"),
  });
  add("build.profile", "build", Boolean(snapshot.build?.profileMatch), {
    severity: "critical", blocksReplies: true, summary: "Build and runtime workflow profiles differ",
    evidence: { profile: snapshot.build?.profile || "unknown" }, fix: fix("manual", "npm run build && iva restart"),
  });

  add("services.systemd", "services", Boolean(snapshot.services?.systemd), {
    severity: "error", blocksReplies: true, summary: "systemd user services are unavailable",
    evidence: { available: Boolean(snapshot.services?.systemd) }, fix: fix("manual", "loginctl enable-linger <service-user>"),
  });
  add("services.agent", "services", Boolean(snapshot.services?.agentActive), {
    severity: "critical", blocksReplies: true, summary: "Agent service is inactive",
    evidence: { active: Boolean(snapshot.services?.agentActive), restarts: Number(snapshot.services?.agentRestarts || 0) },
    fix: fix("automatic", "systemctl --user restart iva.service"),
  });
  add("services.bridge", "services", Boolean(snapshot.services?.bridgeActive), {
    severity: "error", blocksReplies: true, summary: "Telegram bridge is inactive",
    evidence: { active: Boolean(snapshot.services?.bridgeActive), restarts: Number(snapshot.services?.bridgeRestarts || 0) },
    fix: fix("automatic", "systemctl --user restart iva-telegram-poll.service"),
  });
  add("services.readiness", "services", Boolean(snapshot.services?.health), {
    severity: "critical", blocksReplies: true, summary: "Eve readiness probe failed",
    evidence: { healthy: Boolean(snapshot.services?.health) }, fix: fix("manual", "iva recover"),
  });
  add("services.timers", "services", Boolean(snapshot.services?.timersReady), {
    failureStatus: "warn", severity: "warning", summary: "One or more managed timers are disabled",
    evidence: { enabled: Number(snapshot.services?.timersEnabled || 0), expected: Number(snapshot.services?.timersExpected || 0) },
    fix: fix("automatic", "systemctl --user enable --now <iva-timer>"),
  });
  add("services.restart_loop", "services", Number(snapshot.services?.agentRestarts || 0) < 5 && Number(snapshot.services?.bridgeRestarts || 0) < 5, {
    failureStatus: "warn", severity: "error", summary: "A service is repeatedly restarting",
    evidence: { agentRestarts: Number(snapshot.services?.agentRestarts || 0), bridgeRestarts: Number(snapshot.services?.bridgeRestarts || 0) },
    fix: fix("manual", "journalctl --user -u iva.service -u iva-telegram-poll.service -n 100"),
  });

  add("workflow.available", "workflow", Boolean(snapshot.workflow?.available), {
    severity: "critical", blocksReplies: true, summary: "Workflow storage is unavailable",
    evidence: { backend: snapshot.workflow?.backend || "unknown" }, fix: fix("manual", "iva recover"),
  });
  add("workflow.schema", "workflow", snapshot.workflow?.schemaCurrent !== false, {
    severity: "critical", blocksReplies: true, summary: "Workflow schema or migrations are incomplete",
    evidence: { backend: snapshot.workflow?.backend || "unknown", migrationsCurrent: snapshot.workflow?.schemaCurrent !== false },
    fix: fix("manual", "iva workflow-postgres enable"),
  });
  add("workflow.write_read", "workflow", Boolean(snapshot.workflow?.writeRead), {
    severity: "critical", blocksReplies: true, summary: "Workflow storage write/read probe failed",
    evidence: { backend: snapshot.workflow?.backend || "unknown" }, fix: fix("manual", "iva recover"),
  });
  add("workflow.wedged", "workflow", Number(snapshot.workflow?.wedged || 0) === 0, {
    severity: "error", blocksReplies: false, summary: "Wedged workflow runs detected",
    evidence: { count: Number(snapshot.workflow?.wedged || 0) }, fix: fix("manual", "iva recover"),
  });
  add("workflow.growth", "workflow", !snapshot.workflow?.runawayGrowth, {
    failureStatus: "warn", severity: "warning", summary: "Workflow storage is growing unusually fast",
    evidence: { bytesPerHour: Number(snapshot.workflow?.growthPerHour || 0), chunks: Number(snapshot.workflow?.chunks || 0) },
    fix: fix("manual", "iva status"),
  });

  add("telegram.configuration", "telegram", Boolean(snapshot.telegram?.configured), {
    severity: "critical", blocksReplies: true, summary: "Telegram configuration is incomplete",
    evidence: { configured: Boolean(snapshot.telegram?.configured) }, fix: fix("manual", "iva config"),
  });
  add("telegram.delivery", "telegram", Boolean(snapshot.telegram?.bridgeReady), {
    severity: "error", blocksReplies: true, summary: "Telegram delivery bridge is not ready",
    evidence: { ready: Boolean(snapshot.telegram?.bridgeReady) }, fix: fix("automatic", "systemctl --user restart iva-telegram-poll.service"),
  });

  add("provider.configuration", "provider", Boolean(snapshot.provider?.configured), {
    severity: "critical", blocksReplies: true, summary: "Model provider is not configured",
    evidence: { provider: snapshot.provider?.name || "unknown" }, fix: fix("manual", "iva config"),
  });
  const providerAge = ageHours(snapshot.provider?.lastSuccessAt, now);
  add("provider.recent_success", "provider", providerAge !== null && providerAge <= 24 * 7, {
    failureStatus: "warn", severity: "warning", summary: "No recent successful model step is recorded",
    evidence: { lastSuccessAgeHours: providerAge }, fix: fix("manual", "send one normal message to Iva"),
  });

  const memoryAge = ageHours(snapshot.memory?.lastJobSuccessAt, now);
  add("memory.job", "memory", memoryAge !== null && memoryAge <= 48, {
    failureStatus: "warn", severity: "warning", summary: "Memory maintenance has not succeeded recently",
    evidence: { lastSuccessAgeHours: memoryAge }, fix: fix("manual", "systemctl --user start iva-memory-doctor.service"),
  });
  add("memory.vault", "memory", Boolean(snapshot.memory?.vault), {
    severity: "error", blocksReplies: false, summary: "Memory vault is unavailable",
    evidence: { available: Boolean(snapshot.memory?.vault) }, fix: fix("manual", "npm run init-vault"),
  });
  add("memory.index", "memory", snapshot.memory?.indexReady !== false, {
    failureStatus: "warn", severity: "warning", summary: "Hybrid memory index is missing or stale",
    evidence: { mode: snapshot.configuration?.memoryMode || "unknown" }, fix: fix("manual", "node scripts/memory/embed-index.ts"),
  });

  const reminderAge = ageHours(snapshot.backups?.lastReminderDispatchAt, now);
  add("backups.reminder_dispatch", "backups", reminderAge !== null && reminderAge <= 48, {
    failureStatus: "warn", severity: "warning", summary: "Reminder dispatcher has no recent successful run",
    evidence: { lastSuccessAgeHours: reminderAge }, fix: fix("manual", "systemctl --user start iva-reminders.service"),
  });
  const vaultBackupAge = ageHours(snapshot.backups?.lastVaultBackupAt, now);
  add("backups.vault", "backups", Boolean(snapshot.backups?.vaultRemote) && vaultBackupAge !== null && vaultBackupAge <= 48, {
    failureStatus: "warn", severity: "error", summary: "Vault backup is missing or stale",
    evidence: { remoteConfigured: Boolean(snapshot.backups?.vaultRemote), lastSuccessAgeHours: vaultBackupAge },
    fix: fix("manual", "systemctl --user start iva-memory-doctor.service"),
  });
  add("backups.database", "backups", snapshot.workflow?.backend !== "postgres" || Boolean(snapshot.backups?.databaseBackup), {
    failureStatus: "warn", severity: "error", summary: "No verified PostgreSQL backup is recorded",
    evidence: { required: snapshot.workflow?.backend === "postgres", verified: Boolean(snapshot.backups?.databaseBackup) },
    fix: fix("manual", "create and verify a PostgreSQL dump before migrations"),
  });

  const freeBytes = Number(snapshot.capacity?.freeBytes || 0);
  const freePercent = Number(snapshot.capacity?.freePercent || 0);
  const capacityCritical = freeBytes < 256 * 1024 * 1024 || freePercent < 2;
  const capacityHealthy = freeBytes >= 1024 * 1024 * 1024 && freePercent >= 10;
  checks.push(check("capacity.disk", "capacity", capacityHealthy ? "pass" : capacityCritical ? "fail" : "warn", {
    severity: capacityCritical ? "critical" : "warning", blocksReplies: capacityCritical,
    summary: capacityCritical ? "Disk capacity is critically low" : "Disk capacity is low",
    evidence: { freeBytes, freePercent }, fix: fix("manual", "free disk space, then run: iva doctor"),
  }));
  if (snapshot.capacity?.observed) {
    const freeInodesPercent = Number(snapshot.capacity.freeInodesPercent ?? 100);
    checks.push(check("capacity.inodes", "capacity", freeInodesPercent >= 10 ? "pass" : freeInodesPercent < 2 ? "fail" : "warn", {
      severity: freeInodesPercent < 2 ? "critical" : "warning", blocksReplies: freeInodesPercent < 2,
      summary: freeInodesPercent < 2 ? "Filesystem inode capacity is critically low" : "Filesystem inode capacity is low",
      evidence: { freePercent: freeInodesPercent }, fix: fix("manual", "inspect small-file growth, then run: iva status"),
    }));
    const swapUsedPercent = Number(snapshot.capacity.swapUsedPercent || 0);
    checks.push(check("capacity.swap", "capacity", swapUsedPercent < 90 ? "pass" : "warn", {
      severity: "warning", blocksReplies: false, summary: "Swap pressure is high",
      evidence: { usedPercent: swapUsedPercent }, fix: fix("manual", "inspect memory pressure with: iva status"),
    }));
    const baselineReady = Number(snapshot.capacity.baselineDays || 0) >= 7;
    const daysUntilFull = snapshot.capacity.daysUntilFull === null ? null : Number(snapshot.capacity.daysUntilFull);
    const runaway = baselineReady && daysUntilFull !== null && Number(snapshot.capacity.workflowGrowthPerDay || 0) >= 10 * 1024 ** 2 && daysUntilFull <= 7;
    checks.push(check("capacity.workflow_growth", "capacity", !runaway ? "pass" : "warn", {
      severity: "warning", blocksReplies: false, summary: "Workflow growth could fill the disk within seven days",
      evidence: { baselineDays: Number(snapshot.capacity.baselineDays || 0), bytesPerDay: Number(snapshot.capacity.workflowGrowthPerDay || 0), daysUntilFull },
      fix: fix("manual", "run iva status; do not delete Workflow tables manually"),
    }));
  }

  const blocking = checks.filter((item) => item.status === "fail" && item.blocksReplies);
  const unhealthy = checks.filter((item) => item.status === "fail" || item.status === "warn");
  const status = blocking.length ? "blocked" : unhealthy.length ? "degraded" : "healthy";
  return sanitizeSupportBundle({
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    status,
    exitCode: blocking.length ? 1 : 0,
    summary: {
      pass: checks.filter((item) => item.status === "pass").length,
      fixed: checks.filter((item) => item.status === "fixed").length,
      warn: checks.filter((item) => item.status === "warn").length,
      fail: checks.filter((item) => item.status === "fail").length,
      blocking: blocking.length,
    },
    checks,
  });
}

export function sanitizeSupportBundle(value) {
  if (Array.isArray(value)) return value.map(sanitizeSupportBundle);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, child]) => [key, sanitizeSupportBundle(child)]));
  }
  if (typeof value === "string" && PRIVATE_VALUE.test(value)) return "[redacted]";
  return value;
}

export function formatDoctorReport(report) {
  const icon = report.status === "healthy" ? "✓" : report.status === "degraded" ? "!" : "✗";
  const lines = [`${icon} Iva doctor: ${report.status}`];
  for (const component of DOCTOR_COMPONENTS) {
    const items = report.checks.filter((item) => item.component === component);
    const bad = items.filter((item) => item.status === "fail" || item.status === "warn");
    if (!bad.length) lines.push(`✓ ${component}`);
    else lines.push(`${bad.some((item) => item.status === "fail") ? "✗" : "!"} ${component}: ${bad.map((item) => item.summary).join("; ")}`);
  }
  if (report.summary.fixed) lines.push(`fixed: ${report.summary.fixed}`);
  lines.push(`summary: ${report.summary.pass} pass · ${report.summary.warn} warn · ${report.summary.fail} fail · ${report.summary.blocking} blocking`);
  return lines.join("\n");
}
