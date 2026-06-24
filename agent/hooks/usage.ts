import { defineHook } from "eve/hooks";
import { appendUsage } from "../../scripts/lib/usage.mjs";

const PROVIDER = process.env.MODEL_PROVIDER ?? "ollama";
const MODEL =
  PROVIDER === "opencode"
    ? (process.env.OPENCODE_MODEL ?? "deepseek-v4-pro").replace(/^opencode-go\//, "")
    : (process.env.OLLAMA_MODEL ?? "deepseek-v4-pro");

interface StepData {
  stepIndex: number;
  turnId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

function record(data: StepData, sessionId: string, source: string, subagent?: string): void {
  const u = data.usage;
  if (!u) return;
  const input = u.inputTokens ?? 0;
  const output = u.outputTokens ?? 0;
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  if (input + output + cacheRead + cacheWrite === 0) return;
  appendUsage({
    ts: new Date().toISOString(),
    source,
    provider: PROVIDER,
    model: MODEL,
    sessionId,
    turnId: data.turnId ?? "",
    step: data.stepIndex ?? 0,
    subagent,
    in: input,
    out: output,
    cacheRead,
    cacheWrite,
    total: input + output,
  });
}

export default defineHook({
  events: {
    "step.completed": (event, ctx) => {
      record(event.data, ctx.session.id, ctx.channel.kind ?? "unknown");
    },
    "subagent.event": (event, ctx) => {
      const inner = event.data.event;
      if (inner.type === "step.completed") {
        record(inner.data, ctx.session.id, ctx.channel.kind ?? "unknown", event.data.subagentName);
      }
    },
  },
});
