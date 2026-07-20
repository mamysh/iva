import type { ModelProvider, ThinkingEffort } from "./model-catalog.mjs";

export interface ProviderModelProfile {
  provider: ModelProvider;
  textModel: string;
  visionModel: string;
  contextWindow: number;
}

export interface ResolvedModelRoles {
  text: { provider: ModelProvider; model: string; contextWindow: number };
  vision: { provider: ModelProvider; model: string };
  effort: {
    requested?: ThinkingEffort;
    effective?: ThinkingEffort;
    supported: readonly ThinkingEffort[];
  };
  profiles: Record<ModelProvider, ProviderModelProfile>;
}

export function resolveModelRoles(env?: Record<string, string | undefined>): ResolvedModelRoles;
