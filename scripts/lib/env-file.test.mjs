import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MODEL_CONFIG_KEYS, parseEnvText, readEnvValues, upsertModelEnv } from "./env-file.mjs";

const directory = await mkdtemp(join(tmpdir(), "iva-model-env-"));
const path = join(directory, ".env");

try {
  assert.deepEqual(parseEnvText('A=1\r\n# comment\r\nB="two"\r\nC=\'three\''), { A: "1", B: "two", C: "three" });
  assert.deepEqual(await readEnvValues(join(directory, "missing")), {});
  assert.ok(MODEL_CONFIG_KEYS.includes("VISION_PROVIDER"));
  assert.ok(MODEL_CONFIG_KEYS.includes("CODEX_VISION_MODEL"));

  await upsertModelEnv(path, { MODEL_PROVIDER: "codex", CODEX_MODEL: "fixture-text" });
  assert.equal(await readFile(path, "utf8"), "MODEL_PROVIDER=codex\nCODEX_MODEL=fixture-text\n");
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  await writeFile(path, "# keep\r\nMODEL_PROVIDER=ollama\r\nUNKNOWN=value\r\nMODEL_PROVIDER=duplicate\r\n", "utf8");
  await chmod(path, 0o644);
  await upsertModelEnv(path, {
    MODEL_PROVIDER: "codex",
    VISION_PROVIDER: "ollama",
    THINKING_EFFORT: "high",
    CODEX_VISION_MODEL: "fixture-vision",
  });
  assert.equal(
    await readFile(path, "utf8"),
    "# keep\nMODEL_PROVIDER=codex\nUNKNOWN=value\nVISION_PROVIDER=ollama\nTHINKING_EFFORT=high\nCODEX_VISION_MODEL=fixture-vision\n",
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600, "an insecure existing mode must be tightened");

  const before = await readFile(path, "utf8");
  await assert.rejects(() => upsertModelEnv(path, { TELEGRAM_BOT_TOKEN: "blocked" }), /not allowed/);
  await assert.rejects(() => upsertModelEnv(path, { CODEX_MODEL: "line1\nline2" }), /newline/);
  assert.equal(await readFile(path, "utf8"), before, "rejected updates must not alter the file");

  await upsertModelEnv(path, { THINKING_EFFORT: null });
  assert.doesNotMatch(await readFile(path, "utf8"), /THINKING_EFFORT/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("model env file checks passed: allowlist, CRLF, atomic mode and preservation");
