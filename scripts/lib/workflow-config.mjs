export const POSTGRES_WORKFLOW_WORLD = "@workflow/world-postgres";

export function normalizeWorkflowWorld(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "local" || raw === "@workflow/world-local") return "";
  if (raw === "postgres") return POSTGRES_WORKFLOW_WORLD;
  return raw;
}

export function workflowAgentOptions(env = process.env) {
  const world = normalizeWorkflowWorld(env.WORKFLOW_TARGET_WORLD || env.IVA_WORKFLOW_WORLD);
  return world ? { experimental: { workflow: { world } } } : {};
}

export function isPostgresWorkflow(env = process.env) {
  return normalizeWorkflowWorld(env.WORKFLOW_TARGET_WORLD || env.IVA_WORKFLOW_WORLD) === POSTGRES_WORKFLOW_WORLD;
}
