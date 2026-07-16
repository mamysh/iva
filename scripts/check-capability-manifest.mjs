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
assert.ok(manifest.systemd.managedTimers.includes("iva-reminders.timer"));
assert.equal(manifest.storage.defaultProfile, "local");
assert.ok(manifest.storage.profiles.some(({ name, world }) => name === "postgres" && world === "@workflow/world-postgres"));
assert.equal(manifest.storage.lifecycle.recoverCommand, "iva recover");
assert.equal(manifest.storage.lifecycle.updateTransactionSource, "scripts/update-runtime.mjs");
assert.equal(manifest.storage.lifecycle.doctorJsonCommand, "iva doctor --json");
assert.equal(manifest.storage.lifecycle.doctorSchemaVersion, 1);
assert.equal(manifest.storage.lifecycle.purgeCommand, null);
assert.match(manifest.runtime.node, /^24/);
assert.equal(manifest.runtime.eve, "0.11.10");

const serialized = JSON.stringify(manifest);
assert.doesNotMatch(serialized, /(?:api[_-]?key|password|secret|token|authorization)/i);
assert.doesNotMatch(serialized, /(?:^|[\s"'])(?:\/home\/|\/Users\/|\.env)/);

console.log("capability manifest checks passed");
