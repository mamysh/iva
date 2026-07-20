import { chmod, mkdir, open, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { MODEL_CATALOG, THINKING_EFFORTS, isModelProvider, providerSupportsEffort } from "./model-catalog.mjs";
import { parseEnvText, renderModelEnv } from "./env-file.mjs";
import { resolveModelRoles } from "./model-profile.mjs";

const SAFE_MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,180}$/;

async function privateAtomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "w", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function modelSelectionUpdates(currentEnv, selection) {
  const before = resolveModelRoles(currentEnv);
  if (selection?.role === "effort") {
    const effort = String(selection.effort || "").toLowerCase();
    if (!THINKING_EFFORTS.includes(effort) || !providerSupportsEffort(before.text.provider, effort)) {
      throw new Error("thinking effort is not supported by the active text provider");
    }
    return { THINKING_EFFORT: effort };
  }

  if (!new Set(["text", "vision"]).has(selection?.role) || !isModelProvider(selection?.provider)) {
    throw new Error("invalid model role or provider");
  }
  if (!SAFE_MODEL_ID.test(String(selection.model || ""))) throw new Error("invalid model identifier");
  const catalog = MODEL_CATALOG[selection.provider];
  if (selection.role === "vision") {
    return { VISION_PROVIDER: selection.provider, [catalog.visionModelSelector]: selection.model };
  }

  const updates = { MODEL_PROVIDER: selection.provider, [catalog.textModelSelector]: selection.model };
  // Materialize the old resolved vision role on every text change. This covers both legacy
  // VISION_PROVIDER fallback and Codex's CODEX_VISION_MODEL -> CODEX_MODEL fallback: neither a
  // provider switch nor a same-provider model switch may silently change what sees images.
  const previousVisionCatalog = MODEL_CATALOG[before.vision.provider];
  updates.VISION_PROVIDER = before.vision.provider;
  updates[previousVisionCatalog.visionModelSelector] = before.vision.model;
  return updates;
}

export async function applyModelSelection({
  envPath,
  dataDir,
  selection,
  baseEnvironment = process.env,
  providerAvailable,
  probe,
  restart,
  readiness,
}) {
  const lockPath = join(dataDir, ".model-config.lock");
  const backupPath = join(dataDir, "model-config-backup.env");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const acquireLock = async (allowStaleRecovery) => {
    try {
      await mkdir(lockPath, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ageMs = Date.now() - (await stat(lockPath)).mtimeMs;
      if (allowStaleRecovery && ageMs > 10 * 60_000) {
        await rmdir(lockPath);
        return acquireLock(false);
      }
      throw new Error("another model configuration change is already running");
    }
  };
  await acquireLock(true);

  let wrote = false;
  let original;
  try {
    original = await readFile(envPath);
    const currentFileEnv = parseEnvText(original.toString("utf8"));
    const currentEnv = { ...baseEnvironment, ...currentFileEnv };
    const updates = modelSelectionUpdates(currentEnv, selection);
    const candidateText = renderModelEnv(original.toString("utf8"), updates);
    const candidateEnv = { ...baseEnvironment, ...parseEnvText(candidateText) };
    const before = resolveModelRoles(currentEnv);
    const after = resolveModelRoles(candidateEnv);

    for (const provider of new Set([after.text.provider, after.vision.provider])) {
      if (!(await providerAvailable(provider, candidateEnv))) {
        throw new Error(`provider ${provider} is not configured`);
      }
    }
    await probe({ selection, env: candidateEnv, before, after });

    await privateAtomicWrite(backupPath, original);
    await privateAtomicWrite(envPath, candidateText);
    wrote = true;
    if (!(await restart())) throw new Error("iva.service restart failed");
    if (!(await readiness())) throw new Error("iva.service did not become ready");
    await rm(backupPath, { force: true });
    return { before, after, updates };
  } catch (error) {
    if (wrote && original) {
      await privateAtomicWrite(envPath, original);
      const restarted = await restart().catch(() => false);
      const ready = restarted && await readiness().catch(() => false);
      const wrapped = new Error(`${error.message}; previous configuration ${ready ? "restored" : "restored on disk but service recovery failed"}`);
      wrapped.cause = error;
      wrapped.rolledBack = true;
      throw wrapped;
    }
    throw error;
  } finally {
    await rm(backupPath, { force: true }).catch(() => {});
    await rmdir(lockPath).catch(() => {});
  }
}
