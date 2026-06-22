import { defineAgent } from "eve";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";

const PROVIDERS = {
  ollama: {
    baseURL: "https://ollama.com/v1",
    apiKey: process.env.OLLAMA_API_KEY,
    model: process.env.OLLAMA_MODEL ?? "deepseek-v4-pro",
    window: Number(process.env.OLLAMA_CONTEXT_WINDOW ?? 131072),
  },
  opencode: {
    baseURL: "https://opencode.ai/zen/go/v1",
    apiKey: process.env.OPENCODE_API_KEY,
    model: (process.env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(/^opencode-go\//, ""),
    window: Number(process.env.OPENCODE_CONTEXT_WINDOW ?? 131072),
  },
} as const;

const cfg = PROVIDERS[PROVIDER as keyof typeof PROVIDERS] ?? PROVIDERS.ollama;

const provider = createOpenAICompatible({
  name: `iva-planner-${PROVIDER}`,
  baseURL: cfg.baseURL,
  apiKey: cfg.apiKey,
});

export default defineAgent({
  description:
    "Разбивает крупную цель пользователя на конкретные выполнимые шаги. " +
    "Делегируй сюда, когда задача большая и её нужно декомпозировать на план.",
  model: provider(cfg.model),
  modelContextWindowTokens: cfg.window,
  // Task-mode: при делегировании возвращает структурированный план.
  outputSchema: z.object({
    goal: z.string(),
    steps: z.array(
      z.object({
        title: z.string(),
        detail: z.string(),
        priority: z.enum(["low", "med", "high"]),
      }),
    ),
  }),
});
