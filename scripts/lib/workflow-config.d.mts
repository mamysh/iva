export declare const POSTGRES_WORKFLOW_WORLD = "@workflow/world-postgres";

export declare function normalizeWorkflowWorld(value: unknown): string;

export declare function workflowAgentOptions(env?: Record<string, string | undefined>): {
  experimental?: {
    workflow: {
      world: string;
    };
  };
};

export declare function isPostgresWorkflow(env?: Record<string, string | undefined>): boolean;
