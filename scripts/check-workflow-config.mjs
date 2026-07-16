import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_WORKFLOW_WORLD,
  POSTGRES_WORKFLOW_WORLD,
  assertWorkflowProfileMatch,
  createWorkflowProfileDescriptor,
  isPostgresWorkflow,
  resolveWorkflowProfile,
  workflowAgentOptions,
} from "./lib/workflow-config.mjs";
import { resolveRuntimeWorkflowProfile } from "./lib/workflow-runtime.mjs";

const local = resolveWorkflowProfile({});
assert.equal(local.backend, "local");
assert.equal(local.world, LOCAL_WORKFLOW_WORLD);
assert.equal(resolveWorkflowProfile({ WORKFLOW_TARGET_WORLD: "local" }).backend, "local");
assert.equal(resolveWorkflowProfile({ WORKFLOW_TARGET_WORLD: POSTGRES_WORKFLOW_WORLD }).backend, "postgres");
assert.throws(() => resolveWorkflowProfile({ WORKFLOW_TARGET_WORLD: "postgres" }), /Unsupported WORKFLOW_TARGET_WORLD/);
assert.throws(() => resolveWorkflowProfile({ WORKFLOW_TARGET_WORLD: LOCAL_WORKFLOW_WORLD }), /Unsupported WORKFLOW_TARGET_WORLD/);
assert.throws(() => resolveWorkflowProfile({ IVA_WORKFLOW_WORLD: "postgres" }), /no longer supported/);

assert.deepEqual(workflowAgentOptions({}), {});
assert.deepEqual(workflowAgentOptions({ WORKFLOW_TARGET_WORLD: POSTGRES_WORKFLOW_WORLD }), {
  experimental: { workflow: { world: POSTGRES_WORKFLOW_WORLD } },
});
assert.equal(isPostgresWorkflow({ WORKFLOW_TARGET_WORLD: POSTGRES_WORKFLOW_WORLD }), true);
assert.equal(isPostgresWorkflow({ WORKFLOW_TARGET_WORLD: "local" }), false);

const descriptor = createWorkflowProfileDescriptor(local, { packageVersion: "fixture", selectorSource: "default" });
assert.equal(assertWorkflowProfileMatch(descriptor, local), descriptor);
assert.throws(
  () => assertWorkflowProfileMatch(descriptor, resolveWorkflowProfile({ WORKFLOW_TARGET_WORLD: POSTGRES_WORKFLOW_WORLD })),
  /build=local, runtime=postgres/,
);
assert.throws(() => assertWorkflowProfileMatch(undefined, local), /descriptor is missing or obsolete/);
assert.doesNotMatch(JSON.stringify(descriptor), /URL|password|credential/i);

const root = mkdtempSync(join(tmpdir(), "iva-workflow-profile-"));
try {
  mkdirSync(join(root, "deploy"));
  assert.equal(resolveRuntimeWorkflowProfile(root, {}).profile.backend, "local");
  assert.equal(
    resolveRuntimeWorkflowProfile(root, { WORKFLOW_TARGET_WORLD: POSTGRES_WORKFLOW_WORLD }).profile.backend,
    "postgres",
  );
  writeFileSync(join(root, "deploy/iva-workflow.environment"), `WORKFLOW_TARGET_WORLD=${POSTGRES_WORKFLOW_WORLD}\n`);
  assert.equal(resolveRuntimeWorkflowProfile(root, { WORKFLOW_TARGET_WORLD: "local" }).profile.backend, "postgres");
  writeFileSync(join(root, ".env"), "WORKFLOW_TARGET_WORLD=local\n");
  const installed = resolveRuntimeWorkflowProfile(root, { WORKFLOW_TARGET_WORLD: POSTGRES_WORKFLOW_WORLD });
  assert.equal(installed.profile.backend, "local");
  assert.equal(installed.selectorSource, ".env");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("workflow config checks passed");
