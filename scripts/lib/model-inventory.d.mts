import type { ModelProvider } from "./model-catalog.mjs";

export function modelIdsFromInventory(payload: unknown): string[];
export function listConfiguredModels(
  provider: ModelProvider,
  env: Record<string, string | undefined>,
  options?: { fetchImpl?: typeof fetch; codexModels?: (options: { dataDir: string }) => Promise<string[]> },
): Promise<string[]>;
