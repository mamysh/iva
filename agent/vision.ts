import { providerConfig, providerName, makeCodexModel } from "./provider.js";
import { describeImageWithProvider } from "./lib/vision-provider.mjs";

// Распознаёт картинку vision-моделью ТОГО ЖЕ провайдера (на существующем доступе, без доп-подписок).
// Возвращает текстовое описание, либо "" если распознать нечем (нет ключа/vision-модели).
// Сетевые/HTTP-ошибки бросает — вызывающий ловит и продолжает ход без зрения (graceful).
export async function describeImage(bytes: ArrayBuffer, mimeType?: string): Promise<string> {
  return describeImageWithProvider({
    bytes,
    mimeType,
    providerName,
    providerConfig,
    makeCodexModel,
  });
}
