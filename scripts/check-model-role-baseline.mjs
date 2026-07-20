#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const contractPath = new URL("./baselines/model-role-contract.json", import.meta.url);
const providerUrl = new URL("../agent/provider.ts", import.meta.url).href;
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

assert.equal(contract.schemaVersion, 1);
assert.equal(contract.roles.text.providerSelector, "MODEL_PROVIDER");
assert.equal(contract.roles.vision.providerSelector, null);
assert.equal(contract.roles.vision.followsRole, "text");
assert.equal(contract.roles.effort.selector, null);
assert.deepEqual(contract.roles.effort.supportedProviders, []);
assert.deepEqual(Object.keys(contract.providers).sort(), ["codex", "ollama", "opencode", "openrouter"]);

const probe = `
  const { providerName, providerConfig } = await import(${JSON.stringify(providerUrl)});
  process.stdout.write(JSON.stringify({
    providerName,
    textModel: providerConfig.textModel,
    visionModel: providerConfig.visionModel,
    contextWindow: providerConfig.contextWindow,
  }));
`;

function resolveFixture(env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      NODE_NO_WARNINGS: "1",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr || "provider fixture failed");
  return JSON.parse(result.stdout);
}

const fixtures = [
  {
    name: "legacy default",
    env: {},
    expected: {
      providerName: "ollama",
      textModel: "deepseek-v4-pro",
      visionModel: "minimax-m3",
      contextWindow: 131072,
    },
  },
  {
    name: "legacy Ollama text and vision overrides",
    env: {
      MODEL_PROVIDER: "ollama",
      OLLAMA_MODEL: "fixture-text",
      OLLAMA_VISION_MODEL: "fixture-vision",
      OLLAMA_CONTEXT_WINDOW: "65536",
    },
    expected: {
      providerName: "ollama",
      textModel: "fixture-text",
      visionModel: "fixture-vision",
      contextWindow: 65536,
    },
  },
  {
    name: "legacy OpenCode prefix normalization",
    env: {
      MODEL_PROVIDER: "opencode",
      OPENCODE_MODEL: "opencode-go/fixture-text",
      OPENCODE_CONTEXT_WINDOW: "98304",
    },
    expected: {
      providerName: "opencode",
      textModel: "fixture-text",
      visionModel: "gemini-3-flash",
      contextWindow: 98304,
    },
  },
  {
    name: "legacy OpenRouter fixed vision route",
    env: {
      MODEL_PROVIDER: "openrouter",
      OPENROUTER_MODEL: "fixture/text",
      OPENROUTER_CONTEXT_WINDOW: "114688",
    },
    expected: {
      providerName: "openrouter",
      textModel: "fixture/text",
      visionModel: "google/gemini-2.5-flash",
      contextWindow: 114688,
    },
  },
  {
    name: "legacy Codex shared text and vision model",
    env: {
      MODEL_PROVIDER: "codex",
      CODEX_MODEL: "fixture-codex",
      CODEX_CONTEXT_WINDOW: "196608",
    },
    expected: {
      providerName: "codex",
      textModel: "fixture-codex",
      visionModel: "fixture-codex",
      contextWindow: 196608,
    },
  },
];

for (const fixture of fixtures) {
  assert.deepEqual(resolveFixture(fixture.env), fixture.expected, fixture.name);
}

for (const [provider, capability] of Object.entries(contract.providers)) {
  assert.equal(capability.toolCalling, "required", `${provider}: Iva requires tool calling`);
  assert.ok(capability.textModelSelector, `${provider}: missing text model selector`);
  assert.ok(capability.textDefault, `${provider}: missing text default`);
  assert.ok(capability.visionDefault, `${provider}: missing vision default`);
  assert.equal(typeof capability.liveInventory, "boolean", `${provider}: inventory capability must be explicit`);
}

const serialized = JSON.stringify(contract);
assert.doesNotMatch(serialized, /(?:password|secret|token|authorization)/i);
assert.doesNotMatch(serialized, /(?:^|[\s"'])(?:\/home\/|\/Users\/|\.env)/);

console.log("model role baseline checks passed: legacy text/vision coupling and provider capability table");
