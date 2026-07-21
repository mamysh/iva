#!/usr/bin/env node
import assert from "node:assert/strict";
import { DOCTOR_COMPONENTS, evaluateDoctorSnapshot, formatDoctorReport, sanitizeSupportBundle } from "./lib/doctor-contract.mjs";

const now = Date.parse("2026-07-16T12:00:00Z");
const recent = "2026-07-16T11:00:00Z";
const healthy = {
  configuration: { nodeSupported: true, nodeMajor: 24, required: true, provider: "ollama", search: true, searchProvider: "tavily", memory: true, memoryMode: "hybrid" },
  build: { present: true, profileMatch: true, profile: "postgres" },
  services: { systemd: true, agentActive: true, bridgeActive: true, agentRestarts: 0, bridgeRestarts: 0, health: true, timersReady: true, timersEnabled: 7, timersExpected: 7 },
  updates: { enabled: false, timerEnabled: false, stateValid: true, lastCheckedAt: null },
  workflow: { backend: "postgres", available: true, schemaCurrent: true, writeRead: true, wedged: 0, runawayGrowth: false, chunks: 10 },
  telegram: { configured: true, bridgeReady: true },
  provider: { configured: true, name: "ollama", lastSuccessAt: recent },
  memory: { lastJobSuccessAt: recent, vault: true, indexReady: true },
  backups: { lastReminderDispatchAt: recent, vaultRemote: true, lastVaultBackupAt: recent, databaseBackup: true },
  capacity: { freeBytes: 10 * 1024 ** 3, freePercent: 50, observed: true, freeInodesPercent: 80, swapUsedPercent: 2, workflowGrowthPerDay: 0, daysUntilFull: null, baselineDays: 30 },
};

const report = evaluateDoctorSnapshot(healthy, { now });
assert.equal(report.schemaVersion, 1);
assert.equal(report.status, "healthy");
assert.equal(report.exitCode, 0);
assert.deepEqual([...new Set(report.checks.map((item) => item.component))], DOCTOR_COMPONENTS);
assert.ok(formatDoctorReport(report).split("\n").length <= 12, "healthy doctor output must fit one screen");

const faults = [
  ["configuration.node", { configuration: { ...healthy.configuration, nodeSupported: false, nodeMajor: 22 } }],
  ["configuration.required", { configuration: { ...healthy.configuration, required: false } }],
  ["build.profile", { build: { ...healthy.build, profileMatch: false } }],
  ["services.agent", { services: { ...healthy.services, agentActive: false } }],
  ["services.bridge", { services: { ...healthy.services, bridgeActive: false } }],
  ["services.readiness", { services: { ...healthy.services, health: false } }],
  ["workflow.available", { workflow: { ...healthy.workflow, available: false } }],
  ["workflow.schema", { workflow: { ...healthy.workflow, schemaCurrent: false } }],
  ["workflow.write_read", { workflow: { ...healthy.workflow, writeRead: false } }],
  ["telegram.configuration", { telegram: { ...healthy.telegram, configured: false } }],
  ["provider.configuration", { provider: { ...healthy.provider, configured: false } }],
  ["capacity.disk", { capacity: { freeBytes: 100, freePercent: 1 } }],
];
for (const [id, mutation] of faults) {
  const broken = evaluateDoctorSnapshot({ ...healthy, ...mutation }, { now });
  assert.equal(broken.exitCode, 1, `${id} must block replies`);
  assert.equal(broken.checks.find((item) => item.id === id)?.status, "fail");
  assert.equal(broken.checks.find((item) => item.id === id)?.blocksReplies, true);
}

const degraded = evaluateDoctorSnapshot({
  ...healthy,
  workflow: { ...healthy.workflow, wedged: 2, runawayGrowth: true },
  backups: { ...healthy.backups, vaultRemote: false, databaseBackup: false },
}, { now });
assert.equal(degraded.status, "degraded");
assert.equal(degraded.exitCode, 0);

const updateNotificationsBroken = evaluateDoctorSnapshot({
  ...healthy,
  updates: { enabled: true, timerEnabled: false, stateValid: true, lastCheckedAt: null },
}, { now });
assert.equal(updateNotificationsBroken.checks.find((item) => item.id === "updates.notifications")?.status, "warn");
assert.equal(updateNotificationsBroken.exitCode, 0);

const capacityWarnings = evaluateDoctorSnapshot({
  ...healthy,
  capacity: { ...healthy.capacity, freeInodesPercent: 5, swapUsedPercent: 95, workflowGrowthPerDay: 200 * 1024 ** 2, daysUntilFull: 3 },
}, { now });
for (const id of ["capacity.inodes", "capacity.swap", "capacity.workflow_growth"]) {
  assert.equal(capacityWarnings.checks.find((item) => item.id === id)?.status, "warn", `${id} must be actionable but non-blocking`);
}
assert.equal(capacityWarnings.exitCode, 0);

const fixed = evaluateDoctorSnapshot(healthy, { now, fixed: ["services.agent"] });
assert.equal(fixed.checks.find((item) => item.id === "services.agent")?.status, "fixed");

const sanitized = sanitizeSupportBundle({
  token: "secret",
  nested: { userId: "123", evidence: "postgresql://owner:password@host/database", path: "/home/private/vault" },
  checks: [{ id: "configuration.required", summary: "safe" }],
});
assert.equal("token" in sanitized, false);
assert.equal("userId" in sanitized.nested, false);
assert.equal(sanitized.nested.evidence, "[redacted]");
assert.equal(sanitized.nested.path, "[redacted]");
assert.equal(sanitized.checks[0].id, "configuration.required");
assert.doesNotMatch(JSON.stringify(report), /token|password|\/home\/|\/Users\//i);

console.log("doctor contract checks passed");
