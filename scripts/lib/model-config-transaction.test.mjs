import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyModelSelection, modelSelectionUpdates } from "./model-config-transaction.mjs";

const legacy = {
  MODEL_PROVIDER: "ollama",
  OLLAMA_API_KEY: "fixture-key",
  OLLAMA_MODEL: "old-text",
  OLLAMA_VISION_MODEL: "old-vision",
  CODEX_MODEL: "new-text",
};
assert.deepEqual(modelSelectionUpdates(legacy, { role: "text", provider: "codex", model: "new-text" }), {
  MODEL_PROVIDER: "codex",
  CODEX_MODEL: "new-text",
  VISION_PROVIDER: "ollama",
  OLLAMA_VISION_MODEL: "old-vision",
});
assert.deepEqual(modelSelectionUpdates(legacy, { role: "vision", provider: "ollama", model: "new-vision" }), {
  VISION_PROVIDER: "ollama",
  OLLAMA_VISION_MODEL: "new-vision",
});
assert.deepEqual(
  modelSelectionUpdates({ MODEL_PROVIDER: "codex", CODEX_MODEL: "old-codex" }, { role: "text", provider: "codex", model: "new-codex" }),
  { MODEL_PROVIDER: "codex", CODEX_MODEL: "new-codex", VISION_PROVIDER: "codex", CODEX_VISION_MODEL: "old-codex" },
  "same-provider Codex text switch must pin the previous vision fallback",
);
assert.throws(() => modelSelectionUpdates(legacy, { role: "effort", effort: "high" }), /not supported/);
assert.throws(() => modelSelectionUpdates(legacy, { role: "text", provider: "ollama", model: "bad\nmodel" }), /identifier/);

const directory = await mkdtemp(join(tmpdir(), "iva-model-transaction-"));
const envPath = join(directory, ".env");
const dataDir = join(directory, "data");
const initial = "# private\nMODEL_PROVIDER=ollama\nOLLAMA_API_KEY=fixture-key\nOLLAMA_MODEL=old-text\nOLLAMA_VISION_MODEL=old-vision\n";

try {
  await writeFile(envPath, initial, { mode: 0o644 });
  let restarts = 0;
  const success = await applyModelSelection({
    envPath,
    dataDir,
    selection: { role: "vision", provider: "ollama", model: "minimax-m3" },
    baseEnvironment: {},
    providerAvailable: () => true,
    probe: ({ after }) => assert.equal(after.vision.model, "minimax-m3"),
    restart: async () => { restarts++; return true; },
    readiness: async () => true,
  });
  assert.equal(success.after.text.model, "old-text");
  assert.equal(success.after.vision.model, "minimax-m3");
  assert.equal(restarts, 1);
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  const successfulText = await readFile(envPath, "utf8");

  await assert.rejects(
    applyModelSelection({
      envPath, dataDir,
      selection: { role: "text", provider: "codex", model: "configured-text" },
      baseEnvironment: {}, providerAvailable: (provider) => provider !== "codex", probe: async () => {},
      restart: async () => true, readiness: async () => true,
    }),
    /codex is not configured/,
  );
  assert.equal(await readFile(envPath, "utf8"), successfulText);

  await assert.rejects(
    applyModelSelection({
      envPath, dataDir,
      selection: { role: "text", provider: "ollama", model: "probe-fail" },
      baseEnvironment: {}, providerAvailable: () => true,
      probe: async () => { throw new Error("synthetic probe rejected"); },
      restart: async () => { throw new Error("must not restart"); }, readiness: async () => true,
    }),
    /synthetic probe rejected/,
  );
  assert.equal(await readFile(envPath, "utf8"), successfulText, "probe failure must not write .env");

  let recoveryRestarts = 0;
  await assert.rejects(
    applyModelSelection({
      envPath, dataDir,
      selection: { role: "text", provider: "ollama", model: "rollback-me" },
      baseEnvironment: {}, providerAvailable: () => true, probe: async () => {},
      restart: async () => { recoveryRestarts++; return true; },
      readiness: async () => recoveryRestarts > 1,
    }),
    /previous configuration restored/,
  );
  assert.equal(recoveryRestarts, 2);
  assert.equal(await readFile(envPath, "utf8"), successfulText, "failed readiness must restore exact previous bytes");

  let releaseProbe;
  let markProbeStarted;
  const blockedProbe = new Promise((resolve) => { releaseProbe = resolve; });
  const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
  const first = applyModelSelection({
    envPath, dataDir,
    selection: { role: "vision", provider: "ollama", model: "queued" },
    baseEnvironment: {}, providerAvailable: () => true,
    probe: () => { markProbeStarted(); return blockedProbe; },
    restart: async () => true, readiness: async () => true,
  });
  await probeStarted;
  await assert.rejects(
    applyModelSelection({
      envPath, dataDir,
      selection: { role: "vision", provider: "ollama", model: "concurrent" },
      baseEnvironment: {}, providerAvailable: () => true, probe: async () => {},
      restart: async () => true, readiness: async () => true,
    }),
    /already running/,
  );
  releaseProbe();
  await first;
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("model config transaction checks passed: preservation, lock, probe and readiness rollback");
