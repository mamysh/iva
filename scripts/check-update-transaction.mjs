#!/usr/bin/env node
import assert from "node:assert/strict";
import { createMigrationPlan, createUpdatePreflight, runUpdateTransaction } from "./lib/update-contract.mjs";
import { updateServicePlan } from "./lib/update-services.mjs";

assert.deepEqual(updateServicePlan(false), {
  stopGroups: [["iva-telegram-poll.service"], ["iva.service"]],
  restartUserbot: false,
});
assert.deepEqual(updateServicePlan(true), {
  stopGroups: [["iva-telegram-poll.service", "iva-telegram-userbot.service"], ["iva.service"]],
  restartUserbot: true,
});

const manifest = (migrationVersion, migrations = []) => ({ schemaVersion: 1, migrationVersion, migrations });
const baseline = manifest(0);
const target = (profile, migration = {}) => manifest(1, [{
  version: 1, id: "v1", profiles: [profile], command: null, backup: "none",
  failureStrategy: "forward-compatible", ...migration,
}]);

for (const profile of ["local", "postgres"]) {
  const plan = createMigrationPlan(baseline, target(profile), profile);
  const preflight = createUpdatePreflight({
    currentCommit: "old", targetCommit: "new", currentVersion: "0.2.5", targetVersion: "0.2.6",
    profile, migrationPlan: plan, freeBytes: 10_000, requiredBytes: 1_000, backupReady: true,
  });
  const calls = [];
  const action = (name, result) => async () => { calls.push(name); return result; };
  const result = await runUpdateTransaction({
    preflight, migrationPlan: plan, actions: {
      prepareTarget: action("prepare"), activate: action("activate"), restart: action("restart"),
      readiness: action("readiness", true), commit: action("commit"), cleanup: action("cleanup"),
      rollbackActivation: action("rollback"), restartPrevious: action("restartPrevious"), previousReadiness: action("previousReadiness", true),
    },
  });
  assert.equal(result.outcome, "updated");
  assert.deepEqual(result.events, ["prepare", "activate", "restart", "readiness", "commit"]);
  assert.deepEqual(calls, ["prepare", "activate", "restart", "readiness", "commit", "cleanup"]);
}

const simplePlan = createMigrationPlan(baseline, target("local"), "local");
const simplePreflight = createUpdatePreflight({
  currentCommit: "old", targetCommit: "new", currentVersion: "0.2.5", targetVersion: "0.2.6",
  profile: "local", migrationPlan: simplePlan, freeBytes: 10_000, requiredBytes: 1_000, backupReady: true,
});
const no = async () => {};
const brokenBuild = await runUpdateTransaction({
  preflight: simplePreflight, migrationPlan: simplePlan, actions: {
    prepareTarget: async () => { throw new Error("broken target build"); }, cleanup: no,
  },
});
assert.equal(brokenBuild.outcome, "rolled_back");
assert.equal(brokenBuild.activated, false);
assert.deepEqual(brokenBuild.events, ["prepare"]);

const rollbackCalls = [];
const brokenReadiness = await runUpdateTransaction({
  preflight: simplePreflight, migrationPlan: simplePlan, actions: {
    prepareTarget: no, activate: no, restart: no, readiness: async () => false,
    rollbackActivation: async () => rollbackCalls.push("rollback"),
    restartPrevious: async () => rollbackCalls.push("restart"),
    previousReadiness: async () => true, cleanup: no,
  },
});
assert.equal(brokenReadiness.outcome, "rolled_back");
assert.equal(brokenReadiness.activated, true);
assert.deepEqual(brokenReadiness.events, ["prepare", "activate", "restart", "readiness", "rollback", "restart-previous"]);
assert.deepEqual(rollbackCalls, ["rollback", "restart"]);

const migrationPlan = createMigrationPlan(baseline, target("postgres", {
  command: ["node", "migration.mjs"], backup: "workflow", failureStrategy: "restore",
}), "postgres");
const migrationPreflight = { ...simplePreflight, profile: "postgres", migrations: migrationPlan.migrations, ready: true };
let restored = false;
const brokenMigration = await runUpdateTransaction({
  preflight: migrationPreflight, migrationPlan, actions: {
    prepareTarget: no, createBackup: async () => ({ verified: true }),
    applyMigration: async () => { throw new Error("migration failed"); },
    restoreBackup: async () => { restored = true; }, cleanup: no,
  },
});
assert.equal(brokenMigration.outcome, "rolled_back");
assert.equal(brokenMigration.activated, false);
assert.equal(restored, true);
assert.deepEqual(brokenMigration.events, ["prepare", "backup", "migration:v1", "restore"]);

assert.throws(() => createMigrationPlan(baseline, manifest(2), "local"), /sequential update required/);
assert.equal(createUpdatePreflight({
  currentCommit: "old", targetCommit: "new", currentVersion: "0", targetVersion: "1", profile: "local",
  migrationPlan: simplePlan, freeBytes: 10, requiredBytes: 100, backupReady: true,
}).ready, false);

console.log("update transaction checks passed");
