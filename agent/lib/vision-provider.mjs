import { streamText } from "ai";

import { describeImageOpenAICompatible } from "./vision-openai.mjs";

export const VISION_PROMPT =
  "Опиши изображение детально и по делу: что на нём, дословный текст (OCR), важные детали и цифры. " +
  "Без преамбул и воды — только содержимое.";

export async function describeImageWithProvider({
  bytes,
  mimeType,
  providerName,
  providerConfig,
  makeCodexModel,
  prompt = VISION_PROMPT,
  maxOutputTokens,
}) {
  if (providerName === "codex") {
    if (typeof makeCodexModel !== "function") throw new Error("Codex vision requires a model factory");
    const result = streamText({
      model: makeCodexModel(providerConfig.visionModel),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "file", data: new Uint8Array(bytes), mediaType: mimeType || "image/jpeg" },
          ],
        },
      ],
    });
    let out = "";
    for await (const chunk of result.textStream) out += chunk;
    return out.trim();
  }

  const { baseURL, apiKey, visionModel } = providerConfig;
  if (!apiKey || !visionModel) return "";
  return describeImageOpenAICompatible({ bytes, mimeType, baseURL, apiKey, visionModel, prompt, maxOutputTokens });
}
