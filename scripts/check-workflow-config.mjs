import assert from "node:assert/strict";
import {
  POSTGRES_WORKFLOW_WORLD,
  isPostgresWorkflow,
  normalizeWorkflowWorld,
  workflowAgentOptions,
} from "./lib/workflow-config.mjs";

assert.equal(normalizeWorkflowWorld(undefined), "");
assert.equal(normalizeWorkflowWorld(""), "");
assert.equal(normalizeWorkflowWorld("local"), "");
assert.equal(normalizeWorkflowWorld("@workflow/world-local"), "");
assert.equal(normalizeWorkflowWorld("postgres"), POSTGRES_WORKFLOW_WORLD);
assert.equal(normalizeWorkflowWorld(POSTGRES_WORKFLOW_WORLD), POSTGRES_WORKFLOW_WORLD);

assert.deepEqual(workflowAgentOptions({}), {});
assert.deepEqual(workflowAgentOptions({ WORKFLOW_TARGET_WORLD: "local" }), {});
assert.deepEqual(workflowAgentOptions({ WORKFLOW_TARGET_WORLD: "postgres" }), {
  experimental: { workflow: { world: POSTGRES_WORKFLOW_WORLD } },
});
assert.equal(isPostgresWorkflow({ WORKFLOW_TARGET_WORLD: "postgres" }), true);
assert.equal(isPostgresWorkflow({ WORKFLOW_TARGET_WORLD: "local" }), false);

console.log("workflow config checks passed");
