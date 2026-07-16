import { streamText } from "ai";
import { providerConfig, providerName, makeCodexModel } from "./provider.js";
import { describeImageOpenAICompatible } from "./lib/vision-openai.mjs";

const PROMPT =
  "Опиши изображение детально и по делу: что на нём, дословный текст (OCR), важные детали и цифры. " +
  "Без преамбул и воды — только содержимое.";

// Распознаёт картинку vision-моделью ТОГО ЖЕ провайдера (на существующем доступе, без доп-подписок).
// Возвращает текстовое описание, либо "" если распознать нечем (нет ключа/vision-модели).
// Сетевые/HTTP-ошибки бросает — вызывающий ловит и продолжает ход без зрения (graceful).
export async function describeImage(bytes: ArrayBuffer, mimeType?: string): Promise<string> {
  // codex-подписка: Responses API мультимодален — гоним картинку через ту же модель/токен.
  // ВАЖНО: бэкенд подписки принимает ТОЛЬКО stream:true → streamText, не generateText (иначе 400).
  if (providerName === "codex") {
    const result = streamText({
      model: makeCodexModel(providerConfig.visionModel),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            // file-part (не устаревший image-part): AI SDK кодирует его в input_image для Responses.
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
  return describeImageOpenAICompatible({
    bytes,
    mimeType,
    baseURL,
    apiKey,
    visionModel,
    prompt: PROMPT,
  });
}
