import { defineAgent } from "eve";
// Провайдер и его модели — единый источник в provider.ts (тот же конфиг у agent/vision.ts
// и agent/subagents/planner/agent.ts).
// codex = подписка ChatGPT (Responses API + OAuth); ollama/opencode = OpenAI-совместимый chat.
import {
  compatibleThinkingEffort,
  providerConfig as cfg,
  withReasoningStripped,
  makeTextModel,
} from "./provider.js";

export default defineAgent({
  model: withReasoningStripped(makeTextModel()),
  // eve maps this provider-agnostic setting to reasoning_effort for the
  // OpenAI-compatible Ollama Cloud and OpenCode Go endpoints.
  reasoning: compatibleThinkingEffort,
  // Кастомный провайдер не отдаёт метаданные окна через AI Gateway — задаём вручную.
  // ВАЖНО: значение ОБЯЗАНО быть ≤ реального окна модели, иначе запрос переполнит окно до компактации.
  modelContextWindowTokens: cfg.contextWindow,
  // Защита от overflow: компактуем заранее (0.7 вместо дефолтных 0.9), оставляя запас на
  // summary-вызов и следующий ход. eve сам саммаризирует старые ходы, сохраняя todo и read-tracking.
  compaction: { thresholdPercent: 0.7 },
  // Сессия eve — durable workflow: каждый ход проигрывает весь журнал событий заново, и на
  // сутках активного чата реплей переваливает за потолок 240 с (vercel/workflow), ход
  // не стартует. Сутки от создания — штатный потолок eve: ход завершается, следующее
  // сообщение открывает свежую сессию. Память живёт в vault и это переживает; роллап
  // ротирует свою сессию сам (SESSION_TTL_MS) и обрабатывает session_not_active.
  limits: { sessionTimeoutMs: 24 * 60 * 60 * 1000 },
});
