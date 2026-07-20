#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { listCodexModels } from "./lib/codex-oauth.mjs";
import {
  collectProviderInventory,
  sanitizedProviderEvidence,
  validateVisionCanaryDescription,
  VISION_CANARY_PROMPT,
} from "./lib/release-provider.mjs";

if (process.env.RELEASE_LIVE_CANARY !== "1") {
  throw new Error("live provider canary requires RELEASE_LIVE_CANARY=1 and explicit owner authorization");
}

const {
  providerConfig,
  providerName,
  visionProviderConfig,
  visionProviderName,
  makeCodexModel,
} = await import("../agent/provider.ts");
const { describeImageWithProvider } = await import("../agent/lib/vision-provider.mjs");
const png = readFileSync(new URL("../docs/favicon.png", import.meta.url));
const inventory = await collectProviderInventory({
  provider: visionProviderName,
  baseURL: visionProviderConfig.baseURL,
  apiKey: visionProviderConfig.apiKey,
  visionModel: visionProviderConfig.visionModel,
  codexModels: () => listCodexModels({ dataDir: process.env.ASSISTANT_DATA_DIR || "data" }),
});
const description = await describeImageWithProvider({
  bytes: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
  mimeType: "image/png",
  providerName: visionProviderName,
  providerConfig: visionProviderConfig,
  makeCodexModel,
  prompt: VISION_CANARY_PROMPT,
  maxOutputTokens: 80,
});
validateVisionCanaryDescription(description);
const evidence = sanitizedProviderEvidence({
  textProvider: providerName,
  visionProvider: visionProviderName,
  textModel: providerConfig.textModel,
  visionModel: visionProviderConfig.visionModel,
  inventory,
  description,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
});
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
