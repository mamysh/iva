export const VISION_PROMPT: string;

export function describeImageWithProvider(options: {
  bytes: ArrayBuffer;
  mimeType?: string;
  providerName: string;
  providerConfig: {
    baseURL: string;
    apiKey?: string;
    visionModel: string;
  };
  makeCodexModel?: (model?: string) => unknown;
  prompt?: string;
  maxOutputTokens?: number;
}): Promise<string>;
