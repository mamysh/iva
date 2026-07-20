#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { generateText, jsonSchema, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { validateVisionCanaryDescription, VISION_CANARY_PROMPT } from "./lib/release-provider.mjs";

const role = process.argv[2];
if (!new Set(["text", "vision"]).has(role)) throw new Error("probe role must be text or vision");

const provider = await import("../agent/provider.ts");

async function probeText() {
  const model = provider.providerName === "codex"
    ? provider.makeCodexModel(provider.providerConfig.textModel, "text")
    : createOpenAICompatible({
        name: `iva-probe-${provider.providerName}`,
        baseURL: provider.providerConfig.baseURL,
        apiKey: provider.providerConfig.apiKey,
      })(provider.providerConfig.textModel);
  const result = await generateText({
    model,
    prompt: "Call iva_model_probe exactly once with marker IVA-MODEL-PROBE. Do not answer in text.",
    tools: {
      iva_model_probe: tool({
        description: "Required synthetic capability probe.",
        inputSchema: jsonSchema({
          type: "object",
          properties: { marker: { type: "string", const: "IVA-MODEL-PROBE" } },
          required: ["marker"],
          additionalProperties: false,
        }),
        execute: async ({ marker }) => ({ accepted: marker === "IVA-MODEL-PROBE" }),
      }),
    },
    toolChoice: { type: "tool", toolName: "iva_model_probe" },
    maxOutputTokens: 48,
    maxRetries: 0,
    timeout: 20_000,
  });
  if (!result.toolCalls.some((call) => call.toolName === "iva_model_probe" && call.input?.marker === "IVA-MODEL-PROBE")) {
    throw new Error("text model did not complete the required tool call");
  }
}

async function probeVision() {
  const { describeImageWithProvider } = await import("../agent/lib/vision-provider.mjs");
  const png = await readFile(new URL("../docs/favicon.png", import.meta.url));
  const description = await describeImageWithProvider({
    bytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    mimeType: "image/png",
    providerName: provider.visionProviderName,
    providerConfig: provider.visionProviderConfig,
    makeCodexModel: provider.makeCodexModel,
    prompt: VISION_CANARY_PROMPT,
    maxOutputTokens: 80,
  });
  validateVisionCanaryDescription(description);
}

await (role === "text" ? probeText() : probeVision());
process.stdout.write("ok\n");
