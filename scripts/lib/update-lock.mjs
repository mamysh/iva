import { randomUUID } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

const LOCK_DIRECTORY = "update.lock";
const OWNER_FILE = "owner.json";
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(path) {
  try {
    const value = JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8"));
    if (typeof value.token !== "string" || !Number.isInteger(value.pid)) return null;
    return value;
  } catch {
    return null;
  }
}

export function acquireUpdateLock(
  dataDir,
  { source = "cli", token = randomUUID(), pid = process.pid, now = Date.now(), isProcessAlive = processIsAlive } = {},
) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, LOCK_DIRECTORY);
  const recoveryPath = join(dataDir, `${LOCK_DIRECTORY}.recovery`);

  const claim = () => {
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
      const owner = {
        schemaVersion: 1,
        token,
        source,
        pid,
        startedAt: new Date(now).toISOString(),
      };
      writeFileSync(join(path, OWNER_FILE), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      chmodSync(join(path, OWNER_FILE), 0o600);
      return { ok: true, path, token, owner };
    } catch (error) {
      if (created) rmSync(path, { recursive: true, force: true });
      throw error;
    }
  };

  try {
    return claim();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }

  const observedOwner = readOwner(path);
  if (observedOwner && isProcessAlive(observedOwner.pid)) {
    return { ok: false, path, owner: { source: observedOwner.source, pid: observedOwner.pid, startedAt: observedOwner.startedAt } };
  }

  let age = 0;
  try { age = now - statSync(path).mtimeMs; } catch {}
  // A missing/incomplete owner gets a short grace window so a second process cannot
  // steal the directory while its owner.json is still being written.
  if (!observedOwner && age < INCOMPLETE_LOCK_GRACE_MS) return { ok: false, path, owner: null };

  // Serialize stale-owner recovery separately. Without this guard, two contenders
  // could both remove the dead lock and one could then remove the other's fresh claim.
  try { mkdirSync(recoveryPath, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") return { ok: false, path, owner: observedOwner };
    throw error;
  }
  try {
    const currentOwner = readOwner(path);
    if (currentOwner && (
      isProcessAlive(currentOwner.pid)
      || currentOwner.token !== observedOwner?.token
    )) return { ok: false, path, owner: currentOwner };
    rmSync(path, { recursive: true, force: true });
    try {
      return claim();
    } catch (error) {
      if (error?.code === "EEXIST") return { ok: false, path, owner: readOwner(path) };
      throw error;
    }
  } finally {
    rmSync(recoveryPath, { recursive: true, force: true });
  }
}

export function releaseUpdateLock(lock) {
  if (!lock?.ok || !lock.path || !lock.token || !existsSync(lock.path)) return false;
  const owner = readOwner(lock.path);
  if (!owner || owner.token !== lock.token) return false;
  rmSync(lock.path, { recursive: true, force: true });
  return true;
}
