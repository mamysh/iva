#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import {
  createPortableBackup, hardenPrivateState, readStateEnvironment, restorePortableBackup, verifyPortableBackup,
} from "./lib/portable-backup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const NODE_DIR = dirname(NODE);
const NPM = existsSync(join(NODE_DIR, "npm")) ? join(NODE_DIR, "npm") : "npm";
const ENV = { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH || ""}` };
const CORE_SERVICES = ["iva.service", "iva-telegram-poll.service"];
const OPTIONAL_SERVICES = ["iva-telegram-userbot.service"];
const JOB_SERVICES = ["daily", "weekly", "monthly", "yearly", "doctor"].map((name) => `iva-memory-${name}.service`)
  .concat("iva-reminders.service", "iva-observe.service", "iva-update-check.service");
const TIMERS = ["daily", "weekly", "monthly", "yearly", "doctor"].map((name) => `iva-memory-${name}.timer`)
  .concat("iva-reminders.timer", "iva-observe.timer", "iva-update-check.timer");
const WRITER_UNITS = [...TIMERS, ...CORE_SERVICES, ...OPTIONAL_SERVICES, ...JOB_SERVICES];

function command(program, args, { inherit = false, cwd = ROOT, env = ENV, timeout = 20 * 60_000 } = {}) {
  const result = spawnSync(program, args, {
    cwd, env, encoding: inherit ? undefined : "utf8", stdio: inherit ? "inherit" : "pipe", timeout,
  });
  return { code: result.status ?? 1, out: String(result.stdout || "").trim(), err: String(result.stderr || "").trim() };
}

function must(program, args, options) {
  const result = command(program, args, options);
  if (result.code !== 0) throw new Error(`${program} ${args.join(" ")} failed${result.err ? `: ${result.err.split("\n").at(-1)}` : ""}`);
  return result.out;
}

function requireSystemd() {
  if (command("sh", ["-c", "command -v systemctl >/dev/null"]).code !== 0) {
    throw new Error("backup/restore requires the installed Linux systemd runtime");
  }
}

function activeWriterUnits() {
  return WRITER_UNITS.filter((unit) => command("systemctl", ["--user", "is-active", "--quiet", unit]).code === 0);
}

function stopWriters(active) {
  if (active.length) must("systemctl", ["--user", "stop", ...active], { inherit: true });
  const stillActive = WRITER_UNITS.filter((unit) => command("systemctl", ["--user", "is-active", "--quiet", unit]).code === 0);
  if (stillActive.length) throw new Error(`backup/restore blocked: writers are still active (${stillActive.join(", ")})`);
}

function restartWriters(active) {
  if (active.length) must("systemctl", ["--user", "start", ...active], { inherit: true });
}

function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function commit() {
  return command("git", ["rev-parse", "HEAD"]).out || "unknown";
}

function defaultDestination(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(homedir(), "iva-backups", `iva-${stamp}`);
}

function recordBackupState(result) {
  const source = JSON.parse(JSON.stringify(result.metadata.source));
  const dataSetting = readStateEnvironment(ROOT).ASSISTANT_DATA_DIR || "data";
  const dataDir = isAbsolute(dataSetting) ? dataSetting : resolve(ROOT, dataSetting);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, "backup-state.json");
  const metadataPath = join(result.path, "backup.json");
  const metadataSha256 = createHash("sha256").update(readFileSync(metadataPath)).digest("hex");
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    profile: source.profile,
    artifactPath: result.path,
    metadataSha256,
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function performBackup({ destination, now = new Date(), log = () => {} } = {}) {
  requireSystemd();
  const target = resolve(destination || defaultDestination(now));
  const privacy = hardenPrivateState({ root: ROOT });
  if (!privacy.ok) throw new Error("private state permissions could not be secured");
  const active = activeWriterUnits();
  try {
    stopWriters(active);
    const result = createPortableBackup({
      root: ROOT,
      destination: target,
      writersStopped: true,
      commit: commit(),
      version: packageVersion(),
      createdAt: now,
    });
    verifyPortableBackup(target);
    recordBackupState(result);
    log(`Verified ${result.metadata.files.length} private backup files`);
    return result;
  } finally {
    restartWriters(active);
  }
}

export function performRestore({ backupDir, confirmed = false, log = () => {} } = {}) {
  if (!confirmed) throw new Error("restore requires explicit --yes confirmation");
  requireSystemd();
  const source = resolve(backupDir || "");
  const metadata = verifyPortableBackup(source);
  const active = activeWriterUnits();
  stopWriters(active);
  try {
    const restored = restorePortableBackup({ root: ROOT, backupDir: source, writersStopped: true, force: true });
    hardenPrivateState({ root: ROOT });
    must(NPM, ["run", "build"], { inherit: true });
    must(NODE, ["scripts/check-capability-manifest.mjs"], { inherit: true });
    must(NODE, ["bin/iva.mjs", "_install-units"], { inherit: true });
    log(`Restored ${metadata.files.length} verified files for the ${restored.profile} profile`);
    return restored;
  } catch (error) {
    throw new Error(`${error.message}. Managed services remain stopped; fix the target or restore again before starting Iva`);
  }
}
