export const MODEL_PROVIDERS = Object.freeze(["ollama", "opencode", "openrouter", "codex"]);
export const THINKING_EFFORTS = Object.freeze(["minimal", "low", "medium", "high"]);

export const MODEL_CATALOG = Object.freeze({
  ollama: Object.freeze({
    label: "Ollama Cloud",
    credentialSelector: "OLLAMA_API_KEY",
    textModelSelector: "OLLAMA_MODEL",
    visionModelSelector: "OLLAMA_VISION_MODEL",
    contextWindowSelector: "OLLAMA_CONTEXT_WINDOW",
    textDefault: "deepseek-v4-pro",
    visionDefault: "minimax-m3",
    contextWindowDefault: 131072,
    effort: Object.freeze([]),
  }),
  opencode: Object.freeze({
    label: "OpenCode Go",
    credentialSelector: "OPENCODE_API_KEY",
    textModelSelector: "OPENCODE_MODEL",
    visionModelSelector: "OPENCODE_VISION_MODEL",
    contextWindowSelector: "OPENCODE_CONTEXT_WINDOW",
    textDefault: "deepseek-v4-pro",
    visionDefault: "gemini-3-flash",
    contextWindowDefault: 131072,
    effort: Object.freeze([]),
  }),
  openrouter: Object.freeze({
    label: "OpenRouter",
    credentialSelector: "OPENROUTER_API_KEY",
    textModelSelector: "OPENROUTER_MODEL",
    visionModelSelector: "OPENROUTER_VISION_MODEL",
    contextWindowSelector: "OPENROUTER_CONTEXT_WINDOW",
    textDefault: "openai/gpt-5.1",
    visionDefault: "google/gemini-2.5-flash",
    contextWindowDefault: 131072,
    effort: Object.freeze([]),
  }),
  codex: Object.freeze({
    label: "OpenAI (ChatGPT subscription)",
    credentialSelector: null,
    textModelSelector: "CODEX_MODEL",
    visionModelSelector: "CODEX_VISION_MODEL",
    contextWindowSelector: "CODEX_CONTEXT_WINDOW",
    textDefault: "gpt-5.5",
    visionDefault: "text-model",
    contextWindowDefault: 272000,
    effort: THINKING_EFFORTS,
  }),
});

export function isModelProvider(value) {
  return MODEL_PROVIDERS.includes(value);
}

export function providerSupportsEffort(provider, effort) {
  return isModelProvider(provider) && MODEL_CATALOG[provider].effort.includes(effort);
}

export function providerAccessConfigured(provider, env, { codexAuthenticated = false } = {}) {
  if (!isModelProvider(provider)) return false;
  const selector = MODEL_CATALOG[provider].credentialSelector;
  return selector ? Boolean(String(env?.[selector] ?? "").trim()) : Boolean(codexAuthenticated);
}
