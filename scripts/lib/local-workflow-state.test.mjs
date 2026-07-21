import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectLocalWorkflowState,
  localWorkflowDataPath,
  migrateLocalWorkflowState,
} from "./local-workflow-state.mjs";

function fixture() {
  return mkdtempSync(join(tmpdir(), "iva-local-workflow-state-"));
}

function durableState(path, marker) {
  mkdirSync(join(path, "default", "runs"), { recursive: true });
  writeFileSync(join(path, "version.txt"), "@workflow/world-local@5.0.0-beta.25\n");
  writeFileSync(join(path, "default", "runs", "marker.json"), `${JSON.stringify({ marker })}\n`);
}

const roots = [];
try {
  const fresh = fixture();
  roots.push(fresh);
  assert.equal(migrateLocalWorkflowState({ root: fresh }).outcome, "fresh");
  assert.equal(existsSync(localWorkflowDataPath(fresh)), false);

  const legacy = fixture();
  roots.push(legacy);
  durableState(join(legacy, ".workflow-data"), "legacy");
  const migrated = migrateLocalWorkflowState({ root: legacy, processId: 101 });
  assert.equal(migrated.outcome, "migrated");
  assert.equal(inspectLocalWorkflowState(legacy).legacyExists, true, "migration must preserve rollback state");
  assert.equal(
    readFileSync(join(localWorkflowDataPath(legacy), "default", "runs", "marker.json"), "utf8"),
    '{"marker":"legacy"}\n',
  );
  assert.equal(existsSync(join(legacy, ".eve", ".workflow-data.migrating-101")), false);
  assert.equal(migrateLocalWorkflowState({ root: legacy }).outcome, "current", "repeat must be idempotent");

  const current = fixture();
  roots.push(current);
  durableState(localWorkflowDataPath(current), "current");
  assert.equal(migrateLocalWorkflowState({ root: current }).outcome, "current");

  const both = fixture();
  roots.push(both);
  durableState(join(both, ".workflow-data"), "legacy");
  durableState(localWorkflowDataPath(both), "current");
  assert.equal(migrateLocalWorkflowState({ root: both }).outcome, "current");
  assert.equal(
    readFileSync(join(localWorkflowDataPath(both), "default", "runs", "marker.json"), "utf8"),
    '{"marker":"current"}\n',
    "current state must never be overwritten by stale legacy state",
  );
  assert.equal(
    readFileSync(join(both, ".workflow-data", "default", "runs", "marker.json"), "utf8"),
    '{"marker":"legacy"}\n',
  );
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log("local workflow state migration: ok");
