export const WORKFLOW_PROFILE_CONTRACT_VERSION = 1;
export const POSTGRES_WORKFLOW_WORLD = "@workflow/world-postgres";
export const LOCAL_WORKFLOW_WORLD = "@workflow/world-local";

const RUNTIME_ENVIRONMENT_SOURCE = "deploy/iva-workflow.environment, then .env";

function invalidSelector(value) {
  return new Error(
    `Unsupported WORKFLOW_TARGET_WORLD=${JSON.stringify(value)}. ` +
      `Use "local" (or leave it unset) or "${POSTGRES_WORKFLOW_WORLD}".`,
  );
}

export function resolveWorkflowProfile(env = process.env) {
  const legacy = String(env.IVA_WORKFLOW_WORLD ?? "").trim();
  if (legacy) {
    throw new Error(
      "IVA_WORKFLOW_WORLD is no longer supported. Move its value to WORKFLOW_TARGET_WORLD; " +
        `accepted values are "local" and "${POSTGRES_WORKFLOW_WORLD}".`,
    );
  }

  const raw = String(env.WORKFLOW_TARGET_WORLD ?? "").trim();
  if (!raw || raw === "local") {
    return {
      backend: "local",
      label: "local",
      world: LOCAL_WORKFLOW_WORLD,
      agentWorld: undefined,
      buildTimePackage: LOCAL_WORKFLOW_WORLD,
      dataLocation: ".workflow-data",
      schemaStatus: "embedded; managed by the local Workflow world",
    };
  }
  if (raw === POSTGRES_WORKFLOW_WORLD) {
    return {
      backend: "postgres",
      label: "PostgreSQL",
      world: POSTGRES_WORKFLOW_WORLD,
      agentWorld: POSTGRES_WORKFLOW_WORLD,
      buildTimePackage: POSTGRES_WORKFLOW_WORLD,
      dataLocation: "PostgreSQL via WORKFLOW_POSTGRES_URL",
      schemaStatus: "external; bootstrap/version managed by @workflow/world-postgres",
    };
  }
  throw invalidSelector(raw);
}

export function workflowAgentOptions(env = process.env) {
  const profile = resolveWorkflowProfile(env);
  return profile.agentWorld ? { experimental: { workflow: { world: profile.agentWorld } } } : {};
}

export function isPostgresWorkflow(env = process.env) {
  return resolveWorkflowProfile(env).backend === "postgres";
}

export function createWorkflowProfileDescriptor(profile, { packageVersion, selectorSource = "default" } = {}) {
  return {
    contractVersion: WORKFLOW_PROFILE_CONTRACT_VERSION,
    backend: profile.backend,
    buildTimePackage: profile.buildTimePackage,
    buildTimePackageVersion: packageVersion || "unknown",
    runtimeEnvironmentSource: RUNTIME_ENVIRONMENT_SOURCE,
    selectorSource,
    dataLocation: profile.dataLocation,
    schemaStatus: profile.schemaStatus,
  };
}

export function assertWorkflowProfileMatch(descriptor, runtimeProfile) {
  if (!descriptor || descriptor.contractVersion !== WORKFLOW_PROFILE_CONTRACT_VERSION) {
    throw new Error("Workflow build profile descriptor is missing or obsolete. Run: npm run build");
  }
  if (descriptor.backend !== runtimeProfile.backend) {
    throw new Error(
      `Workflow profile mismatch: build=${descriptor.backend}, runtime=${runtimeProfile.backend}. ` +
        "Rebuild with the current runtime configuration before starting Iva: npm run build",
    );
  }
  return descriptor;
}
