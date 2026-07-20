import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createCapabilityManifest } from "./capability-manifest.mjs";

const manifest = createCapabilityManifest();
const baseline = JSON.parse(readFileSync(new URL("./baselines/capability-manifest.json", import.meta.url), "utf8"));

assert.deepEqual(
  manifest,
  baseline,
  "capability manifest changed; review the diff and intentionally refresh scripts/baselines/capability-manifest.json",
);

const required = {
  tools: ["bash", "memory_search", "reminders", "tasks", "web_search"],
  skills: ["agent-browser", "morning-digest", "security-defense", "web-research"],
  hooks: ["transcript", "usage"],
  channels: ["eve", "telegram"],
  connections: ["telegram-userbot"],
  subagents: ["planner"],
};

for (const [kind, names] of Object.entries(required)) {
  for (const name of names) {
    assert.ok(manifest.agent.capabilities[kind].includes(name), `missing required ${kind} capability: ${name}`);
  }
}

assert.deepEqual(manifest.systemd.managedServices, ["iva-telegram-poll.service", "iva.service"]);
assert.deepEqual(manifest.controls.telegram.modelConfiguration.commands, ["/model", "/think"]);
assert.deepEqual(manifest.controls.telegram.modelConfiguration.roles, ["text", "vision", "effort"]);
assert.equal(manifest.controls.telegram.modelConfiguration.callbackTtlSeconds, 300);
assert.equal(manifest.controls.telegram.modelConfiguration.restartScope, "iva.service");
assert.deepEqual(manifest.controls.telegram.delivery.fallbackOrder, ["rich", "html", "plain"]);
assert.equal(manifest.controls.telegram.delivery.securityBeforeTransport, true);
assert.ok(manifest.systemd.managedTimers.includes("iva-reminders.timer"));
assert.ok(manifest.systemd.managedTimers.includes("iva-observe.timer"));
assert.equal(manifest.extensions.contractVersion, 1);
assert.deepEqual(manifest.extensions.types, [
  "provider", "tool", "skill", "channel-connection", "hook", "subagent", "background-job-timer", "memory-processor-indexer",
]);
assert.equal(manifest.extensions.backgroundPolicy, "managed-oneshot-only");
assert.deepEqual(manifest.extensions.optionalFeatures, [{ name: "telegram-userbot", status: "beta", activation: "iva userbot setup" }]);
assert.equal(manifest.storage.defaultProfile, "local");
assert.ok(manifest.storage.profiles.some(({ name, world }) => name === "postgres" && world === "@workflow/world-postgres"));
assert.equal(manifest.storage.lifecycle.recoverCommand, "iva recover");
assert.equal(manifest.storage.lifecycle.updateTransactionSource, "scripts/update-runtime.mjs");
assert.equal(manifest.storage.lifecycle.backupCommand, "iva backup");
assert.equal(manifest.storage.lifecycle.restoreCommand, "iva restore <portable-backup-directory>");
assert.equal(manifest.storage.lifecycle.dataManifest, "scripts/data-manifest.json");
assert.equal(manifest.storage.lifecycle.portableBackupSchemaVersion, 1);
assert.equal(manifest.storage.lifecycle.doctorJsonCommand, "iva doctor --json");
assert.equal(manifest.storage.lifecycle.doctorSchemaVersion, 1);
assert.equal(manifest.storage.lifecycle.observabilitySchemaVersion, 1);
assert.equal(manifest.storage.lifecycle.observabilityRetentionSamples, 744);
assert.equal(manifest.storage.lifecycle.purgeCommand, null);
assert.equal(manifest.agent.providerRoute.roleContract.roles.vision.defaultFollowsRole, "text");
assert.equal(manifest.agent.providerRoute.roleContract.roles.effort.selector, "THINKING_EFFORT");
assert.deepEqual(
  Object.keys(manifest.agent.providerRoute.roleContract.providers).sort(),
  ["codex", "ollama", "opencode", "openrouter"],
);
assert.match(manifest.runtime.node, /^24/);
assert.equal(manifest.runtime.eve, "0.11.10");

const serialized = JSON.stringify(manifest);
assert.doesNotMatch(serialized, /(?:api[_-]?key|password|secret|token|authorization)/i);
assert.doesNotMatch(serialized, /(?:^|[\s"'])(?:\/home\/|\/Users\/|\.env)/);

console.log("capability manifest checks passed");
