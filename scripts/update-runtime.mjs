#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statfsSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMigrationPlan, createUpdatePreflight, runUpdateTransaction } from "./lib/update-contract.mjs";
import { resolveRuntimeWorkflowProfile } from "./lib/workflow-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATE_DIR = join(ROOT, ".iva-update");
const STAGING_DIR = join(UPDATE_DIR, "staging");
const PREVIOUS_DIR = join(UPDATE_DIR, "previous");
const CONFIG_SNAPSHOT_DIR = join(UPDATE_DIR, "config-snapshot");
const DATA_DIR = resolvePath(readEnvironment().ASSISTANT_DATA_DIR || "data");
const MIGRATION_STATE = join(DATA_DIR, "update-migrations.json");
const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const BASELINE_MANIFEST = { schemaVersion: 1, migrationVersion: 0, migrations: [] };
const NODE_BIN_DIR = dirname(process.execPath);
const NPM = existsSync(join(NODE_BIN_DIR, "npm")) ? join(NODE_BIN_DIR, "npm") : "npm";

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(ROOT, path);
}

function readEnvFile(path) {
  const result = {};
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

function readEnvironment() {
  return {
    ...process.env,
    ...readEnvFile(join(ROOT, "deploy/iva-workflow.environment")),
    ...readEnvFile(join(ROOT, ".env")),
  };
}

function command(program, args, { cwd = ROOT, env = readEnvironment(), inherit = false, timeout = 20 * 60_000 } = {}) {
  const result = spawnSync(program, args, {
    cwd, env, encoding: inherit ? undefined : "utf8", stdio: inherit ? "inherit" : "pipe", timeout,
  });
  return {
    code: result.status ?? 1,
    out: inherit ? "" : String(result.stdout || "").trim(),
    err: inherit ? "" : String(result.stderr || "").trim(),
  };
}

function must(program, args, options) {
  const result = command(program, args, options);
  if (result.code !== 0) throw new Error(`${program} ${args.join(" ")} failed${result.err ? `: ${result.err.split("\n").at(-1)}` : ""}`);
  return result.out;
}

function npm(args, options) {
  if (process.env.npm_execpath) return must(process.execPath, [process.env.npm_execpath, ...args], options);
  return must(NPM, args, options);
}

function git(args, options) {
  return must("git", args, options);
}

function jsonAtRevision(revision, path, fallback) {
  const result = command("git", ["show", `${revision}:${path}`]);
  if (result.code !== 0) return fallback;
  return JSON.parse(result.out);
}

function packageVersion(revision) {
  return jsonAtRevision(revision, "package.json", {}).version || "unknown";
}

function backupToolsReady(profile) {
  if (profile !== "postgres") return true;
  return command("sh", ["-c", "command -v pg_dump >/dev/null && command -v pg_restore >/dev/null"]).code === 0;
}

function postgresEnvironment(urlText) {
  const url = new URL(urlText);
  return Object.fromEntries(Object.entries({
    PGHOST: decodeURIComponent(url.searchParams.get("host") || url.hostname || ""),
    PGPORT: url.port || undefined,
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGUSER: decodeURIComponent(url.username || ""),
    PGPASSWORD: decodeURIComponent(url.password || ""),
    PGCONNECT_TIMEOUT: "10",
  }).filter(([, value]) => value !== undefined));
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function directorySnapshot(path) {
  if (!existsSync(path)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySnapshot(child);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += lstatSync(child).size;
    }
  }
  return { files, bytes };
}

function stagingEnvironment(profile) {
  const home = join(UPDATE_DIR, "staging-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const clean = {
    // npm may be invoked by absolute path, but its lifecycle scripts use `#!/usr/bin/env node`.
    // Non-interactive SSH and systemd environments often omit an NVM-managed Node directory.
    PATH: `${NODE_BIN_DIR}:${process.env.PATH || ""}`,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    LANG: process.env.LANG || "C.UTF-8",
    CI: process.env.CI,
    WORKFLOW_TARGET_WORLD: profile.backend === "local" ? "local" : profile.world,
    NODE_ENV: "development",
  };
  return Object.fromEntries(Object.entries(clean).filter(([, value]) => value !== undefined));
}

function snapshotConfiguration() {
  rmSync(CONFIG_SNAPSHOT_DIR, { recursive: true, force: true });
  mkdirSync(CONFIG_SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
  for (const [relative, name] of [[".env", ".env"], ["deploy/iva-workflow.environment", "workflow.environment"]]) {
    const source = join(ROOT, relative);
    if (!existsSync(source)) continue;
    const target = join(CONFIG_SNAPSHOT_DIR, name);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }
}

function restoreConfiguration() {
  for (const [name, relative] of [[".env", ".env"], ["workflow.environment", "deploy/iva-workflow.environment"]]) {
    const source = join(CONFIG_SNAPSHOT_DIR, name);
    if (!existsSync(source)) continue;
    const target = join(ROOT, relative);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }
}

function removeStagingWorktree() {
  command("git", ["worktree", "remove", "--force", STAGING_DIR]);
  rmSync(STAGING_DIR, { recursive: true, force: true });
  command("git", ["worktree", "prune"]);
}

function serviceActive(name) {
  return command("systemctl", ["--user", "is-active", "--quiet", name]).code === 0;
}

function restartManagedServices() {
  must(process.execPath, ["bin/iva.mjs", "_install-units"], { inherit: true });
  must("systemctl", ["--user", "restart", ...SERVICES], { inherit: true });
  if (serviceActive("iva-telegram-userbot.service")) {
    must("systemctl", ["--user", "restart", "iva-telegram-userbot.service"], { inherit: true });
  }
}

function doctorReady() {
  const result = command(process.execPath, ["bin/iva.mjs", "doctor", "--json"], { timeout: 30_000 });
  if (result.code !== 0) return false;
  try {
    const report = JSON.parse(result.out);
    return report.exitCode === 0 && report.summary?.blocking === 0;
  } catch { return false; }
}

export function createWorkflowBackup(profile, env, targetCommit) {
  const backupDir = join(DATA_DIR, "backups", `update-${targetCommit.slice(0, 12)}`);
  rmSync(backupDir, { recursive: true, force: true });
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  if (profile === "postgres") {
    const url = env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL;
    if (!url) throw new Error("PostgreSQL backup blocked: no workflow connection is configured");
    const path = join(backupDir, "workflow.dump");
    const pgEnv = { ...env, ...postgresEnvironment(url) };
    must("pg_dump", ["--format=custom", "--file", path], { env: pgEnv, inherit: true });
    must("pg_restore", ["--list", path], { env: pgEnv });
    chmodSync(path, 0o600);
    return { verified: true, profile, path };
  }
  const source = resolvePath(env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data");
  const path = join(backupDir, "workflow-local");
  if (!existsSync(source)) throw new Error("local workflow backup blocked: data directory is missing");
  const sourceSnapshot = directorySnapshot(source);
  if (sourceSnapshot.files === 0) throw new Error("local workflow backup blocked: data directory is empty");
  cpSync(source, path, { recursive: true, preserveTimestamps: true });
  const backupSnapshot = directorySnapshot(path);
  if (backupSnapshot.files !== sourceSnapshot.files || backupSnapshot.bytes !== sourceSnapshot.bytes) {
    throw new Error("local workflow backup could not be verified");
  }
  return { verified: true, profile, path };
}

function restoreWorkflowBackup(backup, env) {
  if (!backup?.verified) throw new Error("verified backup is required for restore");
  if (backup.profile === "postgres") {
    const pgEnv = { ...env, ...postgresEnvironment(env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL) };
    must("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", pgEnv.PGDATABASE, backup.path], { env: pgEnv, inherit: true });
    return;
  }
  const target = resolvePath(env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data");
  rmSync(target, { recursive: true, force: true });
  cpSync(backup.path, target, { recursive: true, preserveTimestamps: true });
}

function moveIfPresent(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

export async function performUpdate({ force = false, log = console.log } = {}) {
  const env = readEnvironment();
  const currentCommit = git(["rev-parse", "HEAD"]);
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
  const dirty = command("git", ["status", "--porcelain", "--untracked-files=no"]).out;
  if (dirty) return { outcome: "rolled_back", reason: "tracked working tree changes block update", currentCommit };
  const fetch = command("git", ["fetch", "--prune", "origin", branch]);
  if (fetch.code !== 0) return { outcome: "rolled_back", reason: "git fetch failed", currentCommit };
  const targetCommit = git(["rev-parse", `origin/${branch}`]);
  if (currentCommit === targetCommit && !force) return { outcome: "current", currentCommit, targetCommit };
  if (command("sh", ["-c", "command -v systemctl >/dev/null"]).code !== 0) {
    return { outcome: "rolled_back", reason: "systemd is required for transactional activation", currentCommit, targetCommit };
  }

  const { profile } = resolveRuntimeWorkflowProfile(ROOT, env);
  const committedManifest = jsonAtRevision(currentCommit, "scripts/update-manifest.json", BASELINE_MANIFEST);
  const targetManifest = jsonAtRevision(targetCommit, "scripts/update-manifest.json", BASELINE_MANIFEST);
  let migrationState = { schemaVersion: 1, applied: [] };
  try { migrationState = JSON.parse(readFileSync(MIGRATION_STATE, "utf8")); } catch {}
  const currentManifest = {
    ...committedManifest,
    migrationVersion: Math.max(committedManifest.migrationVersion, Number(migrationState.migrationVersion || 0)),
  };
  let migrationPlan;
  try { migrationPlan = createMigrationPlan(currentManifest, targetManifest, profile.backend); }
  catch (error) { return { outcome: "rolled_back", reason: error.message, currentCommit, targetCommit }; }
  const disk = statfsSync(ROOT);
  const freeBytes = disk.bavail * disk.bsize;
  const activeBytes = directorySnapshot(join(ROOT, ".output")).bytes + directorySnapshot(join(ROOT, "node_modules")).bytes;
  const requiredBytes = Math.max(1024 ** 3, activeBytes * 2);
  const preflight = createUpdatePreflight({
    currentCommit, targetCommit, currentVersion: packageVersion(currentCommit), targetVersion: packageVersion(targetCommit),
    profile: profile.backend,
    migrationPlan,
    freeBytes,
    requiredBytes,
    backupReady: !migrationPlan.requiresBackup || (
      backupToolsReady(profile.backend) && (
        profile.backend === "postgres"
          ? Boolean(env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL)
          : directorySnapshot(resolvePath(env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data")).files > 0
      )
    ),
  });
  log(`Preflight: ${preflight.currentVersion} (${currentCommit.slice(0, 7)}) -> ${preflight.targetVersion} (${targetCommit.slice(0, 7)})`);
  log(`Profile: ${preflight.profile} · migrations: ${preflight.migrations.length} · disk: ${Math.floor(freeBytes / 1024 ** 2)}/${Math.ceil(requiredBytes / 1024 ** 2)} MiB free/required · backup: ${preflight.backupReady ? "ready" : "blocked"}`);

  let writersStopped = false;
  let servicesStopped = false;
  const previousOutput = join(PREVIOUS_DIR, "output");
  const previousModules = join(PREVIOUS_DIR, "node_modules");
  const failedOutput = join(UPDATE_DIR, "failed-output");
  const failedModules = join(UPDATE_DIR, "failed-node_modules");
  const stageEnv = stagingEnvironment(profile);

  const restoreActivation = () => {
    git(["reset", "--hard", currentCommit]);
    rmSync(failedOutput, { recursive: true, force: true });
    rmSync(failedModules, { recursive: true, force: true });
    moveIfPresent(join(ROOT, ".output"), failedOutput);
    moveIfPresent(join(ROOT, "node_modules"), failedModules);
    moveIfPresent(previousOutput, join(ROOT, ".output"));
    moveIfPresent(previousModules, join(ROOT, "node_modules"));
    restoreConfiguration();
  };

  const actions = {
    prepareTarget: async () => {
      removeStagingWorktree();
      rmSync(failedOutput, { recursive: true, force: true });
      rmSync(failedModules, { recursive: true, force: true });
      mkdirSync(UPDATE_DIR, { recursive: true });
      git(["worktree", "add", "--detach", STAGING_DIR, targetCommit]);
      npm(["ci"], { cwd: STAGING_DIR, env: stageEnv, inherit: true });
      npm(["test"], { cwd: STAGING_DIR, env: stageEnv, inherit: true });
      npm(["run", "typecheck"], { cwd: STAGING_DIR, env: stageEnv, inherit: true });
      npm(["run", "build"], { cwd: STAGING_DIR, env: stageEnv, inherit: true });
      must(process.execPath, ["scripts/start.mjs", "--check-profile"], { cwd: STAGING_DIR, env: stageEnv, inherit: true });
      snapshotConfiguration();
    },
    createBackup: async () => {
      if (profile.backend === "local" && !writersStopped && serviceActive("iva.service")) {
        must("systemctl", ["--user", "stop", "iva.service"], { inherit: true });
        writersStopped = true;
      }
      return createWorkflowBackup(profile.backend, env, targetCommit);
    },
    applyMigration: async (migration) => {
      if (!writersStopped && serviceActive("iva.service")) {
        must("systemctl", ["--user", "stop", "iva.service"], { inherit: true });
        writersStopped = true;
      }
      must(migration.command[0], migration.command.slice(1), { cwd: STAGING_DIR, env, inherit: true });
      if (!migrationState.applied.includes(migration.id)) migrationState.applied.push(migration.id);
      migrationState.migrationVersion = migration.version;
      writePrivateJson(MIGRATION_STATE, migrationState);
    },
    restoreBackup: async (backup) => restoreWorkflowBackup(backup, env),
    activate: async () => {
      must("systemctl", ["--user", "stop", ...SERVICES], { inherit: true });
      servicesStopped = true;
      writersStopped = true;
      rmSync(PREVIOUS_DIR, { recursive: true, force: true });
      mkdirSync(PREVIOUS_DIR, { recursive: true, mode: 0o700 });
      writePrivateJson(join(PREVIOUS_DIR, "transaction.json"), { schemaVersion: 1, currentCommit, targetCommit, profile: profile.backend, activatedAt: new Date().toISOString() });
      try {
        git(["reset", "--hard", targetCommit]);
        moveIfPresent(join(ROOT, ".output"), previousOutput);
        moveIfPresent(join(ROOT, "node_modules"), previousModules);
        moveIfPresent(join(STAGING_DIR, ".output"), join(ROOT, ".output"));
        moveIfPresent(join(STAGING_DIR, "node_modules"), join(ROOT, "node_modules"));
      } catch (error) {
        restoreActivation();
        restartManagedServices();
        servicesStopped = false;
        writersStopped = false;
        throw error;
      }
    },
    restart: async () => { restartManagedServices(); servicesStopped = false; writersStopped = false; },
    readiness: async () => doctorReady(),
    commit: async () => writePrivateJson(join(DATA_DIR, "update-state.json"), {
      schemaVersion: 1, status: "updated", previousCommit: currentCommit, currentCommit: targetCommit,
      profile: profile.backend, migrationVersion: migrationPlan.targetVersion, completedAt: new Date().toISOString(),
    }),
    rollbackActivation: async () => {
      must("systemctl", ["--user", "stop", ...SERVICES], { inherit: true });
      servicesStopped = true;
      writersStopped = true;
      restoreActivation();
    },
    restartPrevious: async () => { restartManagedServices(); servicesStopped = false; writersStopped = false; },
    previousReadiness: async () => doctorReady(),
    cleanup: async () => {
      removeStagingWorktree();
      if (servicesStopped) restartManagedServices();
      else if (writersStopped) command("systemctl", ["--user", "restart", "iva.service"], { inherit: true });
    },
  };

  const result = await runUpdateTransaction({ preflight, migrationPlan, actions });
  return { ...result, preflight, currentCommit, targetCommit };
}
