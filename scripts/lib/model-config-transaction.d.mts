import type { ModelProvider, ThinkingEffort } from "./model-catalog.mjs";
import type { ResolvedModelRoles } from "./model-profile.mjs";

export type ModelSelection =
  | { role: "text" | "vision"; provider: ModelProvider; model: string }
  | { role: "effort"; effort: ThinkingEffort };

export function modelSelectionUpdates(
  currentEnv: Record<string, string | undefined>,
  selection: ModelSelection,
): Record<string, string>;

export function applyModelSelection(options: {
  envPath: string;
  dataDir: string;
  selection: ModelSelection;
  baseEnvironment?: Record<string, string | undefined>;
  providerAvailable(provider: ModelProvider, env: Record<string, string | undefined>): boolean | Promise<boolean>;
  probe(context: { selection: ModelSelection; env: Record<string, string | undefined>; before: ResolvedModelRoles; after: ResolvedModelRoles }): unknown | Promise<unknown>;
  restart(): boolean | Promise<boolean>;
  readiness(): boolean | Promise<boolean>;
}): Promise<{ before: ResolvedModelRoles; after: ResolvedModelRoles; updates: Record<string, string> }>;
