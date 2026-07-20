export function describeImageOpenAICompatible(options: {
  bytes: ArrayBuffer;
  mimeType?: string;
  baseURL: string;
  apiKey: string;
  visionModel: string;
  prompt: string;
  maxOutputTokens?: number;
}): Promise<string>;
