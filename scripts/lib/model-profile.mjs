import { MODEL_CATALOG, THINKING_EFFORTS, isModelProvider, providerSupportsEffort } from "./model-catalog.mjs";

function selected(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function providerProfile(provider, env) {
  const catalog = MODEL_CATALOG[provider];
  const rawText = selected(env[catalog.textModelSelector], catalog.textDefault);
  const textModel = provider === "opencode" ? rawText.replace(/^opencode-go\//, "") : rawText;
  const visionFallback = catalog.visionDefault === "text-model" ? textModel : catalog.visionDefault;
  return {
    provider,
    textModel,
    visionModel: selected(env[catalog.visionModelSelector], visionFallback),
    contextWindow: Number(selected(env[catalog.contextWindowSelector], catalog.contextWindowDefault)),
  };
}

export function resolveModelRoles(env = process.env) {
  const rawTextProvider = selected(env.MODEL_PROVIDER, "ollama");
  const textProvider = isModelProvider(rawTextProvider) ? rawTextProvider : "ollama";
  const rawVisionProvider = selected(env.VISION_PROVIDER, textProvider);
  if (!isModelProvider(rawVisionProvider)) {
    throw new Error(`Unsupported VISION_PROVIDER: ${rawVisionProvider}`);
  }

  const profiles = Object.fromEntries(
    Object.keys(MODEL_CATALOG).map((provider) => [provider, providerProfile(provider, env)]),
  );
  const requestedEffort = selected(env.THINKING_EFFORT, "").toLowerCase();
  const validEffort = THINKING_EFFORTS.includes(requestedEffort) ? requestedEffort : undefined;
  const effectiveEffort = providerSupportsEffort(textProvider, validEffort) ? validEffort : undefined;

  return {
    text: { provider: textProvider, model: profiles[textProvider].textModel, contextWindow: profiles[textProvider].contextWindow },
    vision: { provider: rawVisionProvider, model: profiles[rawVisionProvider].visionModel },
    effort: { requested: validEffort, effective: effectiveEffort, supported: MODEL_CATALOG[textProvider].effort },
    profiles,
  };
}
