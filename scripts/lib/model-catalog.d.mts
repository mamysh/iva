export type ModelProvider = "ollama" | "opencode" | "openrouter" | "codex";
export type ThinkingEffort = "minimal" | "low" | "medium" | "high";

export interface ModelCatalogEntry {
  readonly label: string;
  readonly credentialSelector: string | null;
  readonly textModelSelector: string;
  readonly visionModelSelector: string;
  readonly contextWindowSelector: string;
  readonly textDefault: string;
  readonly visionDefault: string;
  readonly contextWindowDefault: number;
  readonly effort: readonly ThinkingEffort[];
  readonly textCandidates: readonly string[];
  readonly visionCandidates: readonly string[];
}

export const MODEL_PROVIDERS: readonly ModelProvider[];
export const THINKING_EFFORTS: readonly ThinkingEffort[];
export const MODEL_CATALOG: Readonly<Record<ModelProvider, ModelCatalogEntry>>;
export function isModelProvider(value: unknown): value is ModelProvider;
export function providerSupportsEffort(provider: unknown, effort: unknown): effort is ThinkingEffort;
export function providerAccessConfigured(
  provider: unknown,
  env: Record<string, string | undefined>,
  options?: { codexAuthenticated?: boolean },
): boolean;
