// Единый источник конфигурации провайдера модели (выбор раз при старте через MODEL_PROVIDER).
// Обе площадки OpenAI-совместимы; ключи — из .env. Здесь же зашита vision-модель ТОГО ЖЕ
// провайдера (один ключ, без доп-подписок) — её зовёт agent/vision.ts для распознавания картинок.
const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";

const PROVIDERS = {
  ollama: {
    baseURL: "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    textModel: process.env.OLLAMA_MODEL ?? "deepseek-v4-pro",
    contextWindow: Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 131072),
    // Дешёвая мультимодалка того же провайдера (проверено на проде: принимает image_url, http 200).
    visionModel: "gemma3:12b",
  },
  opencode: {
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    // Эндпоинт ждёт bare-ID — срезаем внутренний UI-префикс "opencode-go/" из дефолта и старых .env.
    textModel: (process.env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(/^opencode-go\//, ""),
    contextWindow: Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131072),
    visionModel: "gemini-3-flash",
  },
} as const;

export const providerName = PROVIDER;
export const providerConfig = PROVIDERS[PROVIDER as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;
