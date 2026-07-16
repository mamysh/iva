export declare const WORKFLOW_PROFILE_CONTRACT_VERSION = 1;
export declare const POSTGRES_WORKFLOW_WORLD = "@workflow/world-postgres";
export declare const LOCAL_WORKFLOW_WORLD = "@workflow/world-local";

export type WorkflowProfile = {
  backend: "local" | "postgres";
  label: "local" | "PostgreSQL";
  world: string;
  agentWorld?: string;
  buildTimePackage: string;
  dataLocation: string;
  schemaStatus: string;
};

export type WorkflowProfileDescriptor = {
  contractVersion: 1;
  backend: "local" | "postgres";
  buildTimePackage: string;
  buildTimePackageVersion: string;
  runtimeEnvironmentSource: string;
  selectorSource: string;
  dataLocation: string;
  schemaStatus: string;
};

export declare function resolveWorkflowProfile(env?: Record<string, string | undefined>): WorkflowProfile;

export declare function workflowAgentOptions(env?: Record<string, string | undefined>): {
  experimental?: {
    workflow: {
      world: string;
    };
  };
};

export declare function isPostgresWorkflow(env?: Record<string, string | undefined>): boolean;

export declare function createWorkflowProfileDescriptor(
  profile: WorkflowProfile,
  options?: { packageVersion?: string; selectorSource?: string },
): WorkflowProfileDescriptor;

export declare function assertWorkflowProfileMatch(
  descriptor: WorkflowProfileDescriptor | undefined,
  runtimeProfile: WorkflowProfile,
): WorkflowProfileDescriptor;
