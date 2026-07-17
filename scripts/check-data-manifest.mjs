import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("./data-manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.backupFormatVersion, 1);
assert.ok(Array.isArray(manifest.entries) && manifest.entries.length >= 10);

const ids = new Set();
for (const entry of manifest.entries) {
  assert.match(entry.id, /^[a-z0-9.-]+$/);
  assert.ok(!ids.has(entry.id), `duplicate data manifest id: ${entry.id}`);
  ids.add(entry.id);
  assert.ok(typeof entry.path === "string" && entry.path.length > 0);
  assert.doesNotMatch(entry.path, /^\/(?:Users|home|root)\//, `${entry.id} contains a machine-specific path`);
  assert.ok(["file", "file-set", "directory", "database"].includes(entry.type));
  assert.deepEqual(Object.keys(entry.classification).sort(), ["derived", "personal", "secret"]);
  assert.equal(typeof entry.required, "boolean");
  assert.ok(typeof entry.backupMethod === "string" && entry.backupMethod.length > 0);
  assert.ok(Number.isInteger(entry.restoreOrder) && entry.restoreOrder > 0);
  assert.ok(typeof entry.retention === "string" && entry.retention.length > 0);
  assert.ok(typeof entry.lossTolerance === "string" && entry.lossTolerance.length > 0);
  if (entry.classification.derived) {
    assert.equal(entry.required, false, `${entry.id}: derived data cannot be required`);
    assert.match(entry.backupMethod, /exclude-and-rebuild/);
  }
}

for (const id of [
  "configuration.env", "memory.vault", "memory.derived-indexes", "application.tasks",
  "application.reminders", "application.usage", "authentication.codex-oauth",
  "authentication.telegram-userbot", "observability.bounded-history", "workflow.local", "workflow.postgres", "runtime.generated",
]) assert.ok(ids.has(id), `data manifest is missing ${id}`);

console.log("data manifest checks passed");
