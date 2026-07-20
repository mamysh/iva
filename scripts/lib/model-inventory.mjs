import { listCodexModels } from "./codex-oauth.mjs";
import { MODEL_CATALOG, isModelProvider } from "./model-catalog.mjs";

const PROVIDER_ENDPOINTS = Object.freeze({
  ollama: { baseURL: "https://ollama.com/v1", selector: "OLLAMA_BASE_URL" },
  opencode: { baseURL: "https://opencode.ai/zen/go/v1", selector: null },
  openrouter: { baseURL: "https://openrouter.ai/api/v1", selector: null },
});
const MODEL_KEYS = ["model", "slug", "id", "name"];

export function modelIdsFromInventory(payload) {
  const roots = Array.isArray(payload) ? [payload] : [payload?.data, payload?.models, payload?.model_presets];
  return [...new Set(roots.filter(Array.isArray).flat().map((item) => {
    if (typeof item === "string") return item;
    for (const key of MODEL_KEYS) if (typeof item?.[key] === "string") return item[key];
    return null;
  }).filter(Boolean))].sort();
}

export async function listConfiguredModels(provider, env, { fetchImpl = fetch, codexModels = listCodexModels } = {}) {
  if (!isModelProvider(provider)) throw new Error("unsupported provider inventory");
  if (provider === "codex") return codexModels({ dataDir: env.ASSISTANT_DATA_DIR || "data" });
  const endpoint = PROVIDER_ENDPOINTS[provider];
  const baseURL = String(env[endpoint.selector] || endpoint.baseURL).replace(/\/$/, "");
  const apiKey = env[MODEL_CATALOG[provider].credentialSelector];
  const response = await fetchImpl(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    if (provider === "opencode" && response.status === 404) return [];
    throw new Error(`${provider} model inventory unavailable`);
  }
  return modelIdsFromInventory(await response.json());
}
