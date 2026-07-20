import { visionProviderConfig, visionProviderName, makeCodexModel } from "./provider.js";
import { describeImageWithProvider } from "./lib/vision-provider.mjs";

// Распознаёт картинку отдельной vision-ролью. По умолчанию она наследует text provider, поэтому
// старые .env работают как раньше; VISION_PROVIDER позволяет использовать другой уже настроенный доступ.
// Возвращает текстовое описание, либо "" если распознать нечем (нет ключа/vision-модели).
// Сетевые/HTTP-ошибки бросает — вызывающий ловит и продолжает ход без зрения (graceful).
export async function describeImage(bytes: ArrayBuffer, mimeType?: string): Promise<string> {
  return describeImageWithProvider({
    bytes,
    mimeType,
    providerName: visionProviderName,
    providerConfig: visionProviderConfig,
    makeCodexModel,
  });
}
