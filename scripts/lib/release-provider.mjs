const MODEL_KEYS = ["model", "slug", "id", "name"];

function modelIds(payload) {
  const roots = Array.isArray(payload) ? payload : [payload?.data, payload?.models, payload?.model_presets];
  const values = roots.filter(Array.isArray).flat().map((item) => {
    if (typeof item === "string") return item;
    for (const key of MODEL_KEYS) if (typeof item?.[key] === "string") return item[key];
    return null;
  }).filter(Boolean);
  return [...new Set(values)].sort();
}

export async function collectProviderInventory({ provider, baseURL, apiKey, visionModel, fetchImpl = fetch, codexModels }) {
  let models;
  if (provider === "codex") {
    models = await codexModels();
  } else {
    const response = await fetchImpl(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      if (provider === "opencode" && response.status === 404) {
        return { available: false, reason: "endpoint-unavailable", modelCount: null, visionModelPresent: null };
      }
      throw new Error(`${provider} model inventory HTTP ${response.status}`);
    }
    models = modelIds(await response.json());
  }
  if (!models.length) throw new Error(`${provider} model inventory is empty`);
  return {
    available: true,
    reason: null,
    modelCount: models.length,
    visionModelPresent: models.includes(visionModel),
  };
}

export function sanitizedProviderEvidence({ provider, textModel, visionModel, inventory, description, commit }) {
  if (!new Set(["ollama", "opencode", "openrouter", "codex"]).has(provider)) throw new Error("unsupported provider evidence");
  for (const [name, value] of [["text model", textModel], ["vision model", visionModel]]) {
    if (!/^[A-Za-z0-9._:/@+-]+$/.test(value || "")) throw new Error(`unsafe ${name} identifier`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("provider evidence commit must be a full SHA");
  if (!String(description || "").trim()) throw new Error(`${provider} vision canary returned an empty description`);
  if (inventory.available && inventory.visionModelPresent !== true) {
    throw new Error(`${provider} configured vision model is absent from authenticated inventory`);
  }
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    commit,
    provider,
    textModel,
    visionModel,
    inventory,
    vision: { status: "pass", responseCharacters: description.trim().length },
  };
}
