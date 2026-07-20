import assert from "node:assert/strict";

import { listConfiguredModels, modelIdsFromInventory } from "./model-inventory.mjs";

assert.deepEqual(modelIdsFromInventory({ data: [{ id: "z" }, { slug: "a" }, "m", { nope: true }] }), ["a", "m", "z"]);
assert.deepEqual(modelIdsFromInventory({ models: [{ name: "one" }, { model: "two" }, { id: "one" }] }), ["one", "two"]);

let request;
const models = await listConfiguredModels("ollama", { OLLAMA_API_KEY: "fixture", OLLAMA_BASE_URL: "http://fixture/" }, {
  fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => ({ data: [{ id: "model-b" }, { id: "model-a" }] }) };
  },
});
assert.deepEqual(models, ["model-a", "model-b"]);
assert.equal(request.url, "http://fixture/models");
assert.equal(request.options.headers.Authorization, "Bearer fixture");

assert.deepEqual(await listConfiguredModels("opencode", { OPENCODE_API_KEY: "fixture" }, {
  fetchImpl: async () => ({ ok: false, status: 404 }),
}), []);
assert.deepEqual(await listConfiguredModels("codex", { ASSISTANT_DATA_DIR: "/fixture/data" }, {
  codexModels: async ({ dataDir }) => dataDir === "/fixture/data" ? ["codex-a"] : [],
}), ["codex-a"]);
await assert.rejects(listConfiguredModels("openrouter", { OPENROUTER_API_KEY: "fixture" }, {
  fetchImpl: async () => ({ ok: false, status: 500 }),
}), /unavailable/);

console.log("model inventory checks passed: normalized, bounded configured-provider lists");
