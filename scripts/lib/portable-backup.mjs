import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { localWorkflowDataPath } from "./local-workflow-state.mjs";

export const BACKUP_SCHEMA_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const DATA_EXCLUDES = new Set([
  "backups", ".reminders.lock", "update.lock", "update.lock.recovery", "update-jobs",
  "update-notification-state.json", "health-metrics.jsonl", "health-alert-state.json", "workflow-health.json",
]);
const DATA_RECURSIVE_EXCLUDES = new Set([".venv"]);
const VAULT_EXCLUDES = new Set([".index", ".graph"]);

function command(program, args, { cwd, env = process.env, inherit = false, timeout = 20 * 60_000 } = {}) {
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
  if (result.code !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed${result.err ? `: ${result.err.split("\n").at(-1)}` : ""}`);
  }
  return result.out;
}

export function parseEnvironmentFile(path) {
  const result = {};
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

export function readStateEnvironment(root) {
  return {
    ...parseEnvironmentFile(join(root, "deploy/iva-workflow.environment")),
    ...parseEnvironmentFile(join(root, ".env")),
  };
}

function statePath(root, value, fallback) {
  const selected = value || fallback;
  return isAbsolute(selected) ? selected : resolve(root, selected);
}

function workflowProfile(env) {
  return env.WORKFLOW_TARGET_WORLD === "@workflow/world-postgres" ? "postgres" : "local";
}

function secretStateFiles(root, env) {
  const dataDir = statePath(root, env.ASSISTANT_DATA_DIR, "data");
  const files = [
    join(root, ".env"), join(root, "deploy/iva-workflow.environment"), join(dataDir, "reminders.json"),
    join(dataDir, "codex-auth.json"), join(dataDir, "update-channel.json"), join(dataDir, "update-notification-state.json"),
  ];
  if (existsSync(dataDir)) {
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (entry.isFile() && /^telegram-userbot\.(?:token|session|session-journal|health\.json)$/.test(entry.name)) {
        files.push(join(dataDir, entry.name));
      }
    }
  }
  return [...new Set(files)].filter((path) => existsSync(path));
}

export function auditPrivateState({ root, environment } = {}) {
  const appRoot = resolve(root);
  const env = { ...readStateEnvironment(appRoot), ...environment };
  const checks = secretStateFiles(appRoot, env).map((path) => {
    const info = lstatSync(path);
    const mode = info.mode & 0o777;
    const rel = relative(appRoot, path);
    const artifact = rel.startsWith("..") || isAbsolute(rel) ? `external/${path.split(sep).at(-1)}` : rel.split(sep).join("/");
    return { artifact, regular: info.isFile(), private: info.isFile() && (mode & 0o077) === 0, mode };
  });
  return { ok: checks.every((check) => check.private), checks };
}

export function hardenPrivateState({ root, environment } = {}) {
  const appRoot = resolve(root);
  const env = { ...readStateEnvironment(appRoot), ...environment };
  for (const path of secretStateFiles(appRoot, env)) {
    if (!lstatSync(path).isFile()) throw new Error(`private state artifact is not a regular file: ${path}`);
    chmodSync(path, PRIVATE_FILE_MODE);
  }
  return auditPrivateState({ root: appRoot, environment: env });
}

function assertPrivateMode(path, kind) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`backup privacy check failed for ${kind}: ${path}`);
}

function assertInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`unsafe backup path: ${child}`);
  }
  return rel;
}

function copyPrivateTree(source, target, { exclude = new Set(), recursiveExclude = new Set() } = {}) {
  const info = lstatSync(source);
  if (info.isSymbolicLink()) throw new Error(`backup blocked: symbolic links are not supported (${source})`);
  if (info.isFile()) {
    mkdirSync(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
    copyFileSync(source, target);
    chmodSync(target, PRIVATE_FILE_MODE);
    return;
  }
  if (!info.isDirectory()) throw new Error(`backup blocked: special file is not supported (${source})`);
  mkdirSync(target, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(target, PRIVATE_DIR_MODE);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (exclude.has(entry.name) || recursiveExclude.has(entry.name)) continue;
    copyPrivateTree(join(source, entry.name), join(target, entry.name), { recursiveExclude });
  }
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inventoryFiles(root, current = root) {
  if (!existsSync(current)) return [];
  const info = lstatSync(current);
  if (info.isSymbolicLink()) throw new Error(`backup contains a symbolic link: ${current}`);
  if (info.isFile()) {
    assertPrivateMode(current, "file");
    return [{ path: relative(root, current).split(sep).join("/"), bytes: info.size, sha256: hashFile(current) }];
  }
  if (!info.isDirectory()) throw new Error(`backup contains a special file: ${current}`);
  assertPrivateMode(current, "directory");
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => inventoryFiles(root, join(current, entry.name)));
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

export function postgresEnvironment(urlText) {
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

function postgresMajor(text) {
  const match = String(text).match(/(?:PostgreSQL\)?\s+)(\d+)(?:\.|\s|$)/i);
  return match ? Number(match[1]) : null;
}

export function assertPostgresBackupCompatibility(urlText, env = process.env) {
  if (!urlText) throw new Error("PostgreSQL backup blocked: no workflow connection is configured");
  const pgEnv = { ...env, ...postgresEnvironment(urlText) };
  const client = postgresMajor(must("pg_dump", ["--version"], { env: pgEnv }));
  const serverNum = Number(must("psql", ["--tuples-only", "--no-align", "--command", "SHOW server_version_num"], { env: pgEnv }));
  const server = Number.isFinite(serverNum) ? Math.trunc(serverNum / 10_000) : null;
  if (!client || !server) throw new Error("PostgreSQL backup blocked: client/server version could not be determined");
  if (client < server) throw new Error(`PostgreSQL backup blocked: pg_dump ${client} is older than server ${server}`);
  return { clientMajor: client, serverMajor: server, pgEnv };
}

function copyOptional(source, target, options) {
  if (!existsSync(source)) return false;
  copyPrivateTree(source, target, options);
  return true;
}

export function verifyPortableBackup(backupDir) {
  const root = resolve(backupDir);
  const metadataPath = join(root, "backup.json");
  if (!existsSync(metadataPath)) throw new Error("portable backup is missing backup.json");
  assertPrivateMode(root, "directory");
  assertPrivateMode(metadataPath, "file");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.schemaVersion !== BACKUP_SCHEMA_VERSION) throw new Error("unsupported portable backup schema");
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) throw new Error("portable backup has no files");
  const expected = [...metadata.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of expected) {
    if (!file.path || file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`unsafe portable backup entry: ${file.path}`);
    }
    assertInside(root, join(root, file.path));
  }
  const actual = inventoryFiles(root)
    .filter((file) => file.path !== "backup.json")
    .sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("portable backup checksum or file inventory mismatch");
  return metadata;
}

export function createPortableBackup({
  root,
  destination,
  writersStopped = false,
  environment,
  profile,
  createdAt = new Date(),
  commit = "unknown",
  version = "unknown",
} = {}) {
  if (!writersStopped) throw new Error("portable backup requires all managed writers to be stopped");
  const appRoot = resolve(root);
  const target = resolve(destination);
  if (existsSync(target)) throw new Error(`backup destination already exists: ${target}`);
  if (target === appRoot || target.startsWith(`${appRoot}${sep}`)) {
    throw new Error("backup destination must be outside the Iva code repository");
  }
  const env = { ...readStateEnvironment(appRoot), ...environment };
  const selectedProfile = profile || workflowProfile(env);
  if (!existsSync(join(appRoot, ".env"))) throw new Error("portable backup blocked: .env is missing");
  const dataDir = statePath(appRoot, env.ASSISTANT_DATA_DIR, "data");
  const vaultDir = statePath(appRoot, env.ASSISTANT_VAULT_DIR, "vault");
  const workflowDir = localWorkflowDataPath(appRoot);
  if (!existsSync(vaultDir)) throw new Error("portable backup blocked: live vault is missing");
  const privacy = auditPrivateState({ root: appRoot, environment: env });
  if (!privacy.ok) throw new Error("portable backup blocked: one or more secret state files are group/world accessible");
  for (const source of [dataDir, vaultDir, workflowDir]) {
    if (existsSync(source) && (target === source || target.startsWith(`${source}${sep}`))) {
      throw new Error("backup destination must be outside managed state directories");
    }
  }

  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(join(temporary, "payload"), { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    copyPrivateTree(join(appRoot, ".env"), join(temporary, "payload/config/.env"));
    copyOptional(join(appRoot, "deploy/iva-workflow.environment"), join(temporary, "payload/config/workflow.environment"));
    copyOptional(dataDir, join(temporary, "payload/data"), {
      exclude: DATA_EXCLUDES,
      recursiveExclude: DATA_RECURSIVE_EXCLUDES,
    });
    copyPrivateTree(vaultDir, join(temporary, "payload/vault"), { exclude: VAULT_EXCLUDES });

    let postgres = null;
    if (selectedProfile === "postgres") {
      const url = env.WORKFLOW_POSTGRES_URL || env.DATABASE_URL;
      const compatibility = assertPostgresBackupCompatibility(url, env);
      const dump = join(temporary, "payload/workflow/postgres.dump");
      mkdirSync(dirname(dump), { recursive: true, mode: PRIVATE_DIR_MODE });
      must("pg_dump", ["--format=custom", "--file", dump], { env: compatibility.pgEnv, inherit: true });
      must("pg_restore", ["--list", dump], { env: compatibility.pgEnv });
      chmodSync(dump, PRIVATE_FILE_MODE);
      postgres = { clientMajor: compatibility.clientMajor, serverMajor: compatibility.serverMajor };
    } else {
      if (!existsSync(workflowDir)) throw new Error("portable backup blocked: local workflow state is missing");
      copyPrivateTree(workflowDir, join(temporary, "payload/workflow/local"));
    }

    const files = inventoryFiles(temporary).filter((file) => file.path !== "backup.json");
    const metadata = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      createdAt: createdAt.toISOString(),
      source: { commit, version, profile: selectedProfile },
      postgres,
      exclusions: ["data/backups", "data/**/.venv", "data/.reminders.lock", "data/health-metrics.jsonl", "data/health-alert-state.json", "data/workflow-health.json", "vault/.index", "vault/.graph"],
      files,
    };
    writePrivateJson(join(temporary, "backup.json"), metadata);
    verifyPortableBackup(temporary);
    mkdirSync(dirname(target), { recursive: true, mode: PRIVATE_DIR_MODE });
    renameSync(temporary, target);
    chmodSync(target, PRIVATE_DIR_MODE);
    return { path: target, metadata: verifyPortableBackup(target) };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function restorePortableBackup({
  root,
  backupDir,
  writersStopped = false,
  force = false,
  targetEnvironment = {},
} = {}) {
  if (!writersStopped) throw new Error("portable restore requires all managed writers to be stopped");
  if (!force) throw new Error("portable restore is destructive and requires explicit force confirmation");
  const appRoot = resolve(root);
  const backupRoot = resolve(backupDir);
  const metadata = verifyPortableBackup(backupRoot);
  const restoredEnv = {
    ...parseEnvironmentFile(join(backupRoot, "payload/config/workflow.environment")),
    ...parseEnvironmentFile(join(backupRoot, "payload/config/.env")),
    ...targetEnvironment,
  };
  const dataDir = statePath(appRoot, restoredEnv.ASSISTANT_DATA_DIR, "data");
  const vaultDir = statePath(appRoot, restoredEnv.ASSISTANT_VAULT_DIR, "vault");
  const workflowDir = localWorkflowDataPath(appRoot);
  if (!existsSync(join(appRoot, "package.json"))) throw new Error("portable restore target must be an installed Iva root");
  const targets = [dataDir, vaultDir, ...(metadata.source.profile === "local" ? [workflowDir] : [])]
    .map((path) => resolve(path));
  for (const target of targets) {
    const rootPath = parse(target).root;
    if (target === rootPath || target === appRoot || appRoot.startsWith(`${target}${sep}`) ||
        target === backupRoot || backupRoot.startsWith(`${target}${sep}`) || target.startsWith(`${backupRoot}${sep}`)) {
      throw new Error(`portable restore blocked: unsafe managed target (${target})`);
    }
  }
  for (let index = 0; index < targets.length; index++) {
    for (let other = index + 1; other < targets.length; other++) {
      if (targets[index] === targets[other] || targets[index].startsWith(`${targets[other]}${sep}`) ||
          targets[other].startsWith(`${targets[index]}${sep}`)) {
        throw new Error("portable restore blocked: managed target directories overlap");
      }
    }
  }
  let postgresCompatibility = null;
  if (metadata.source.profile === "postgres") {
    const url = targetEnvironment.WORKFLOW_POSTGRES_URL || targetEnvironment.DATABASE_URL ||
      restoredEnv.WORKFLOW_POSTGRES_URL || restoredEnv.DATABASE_URL;
    postgresCompatibility = assertPostgresBackupCompatibility(url, { ...process.env, ...restoredEnv, ...targetEnvironment });
  }

  mkdirSync(appRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
  if (metadata.source.profile === "local") rmSync(workflowDir, { recursive: true, force: true });

  copyPrivateTree(join(backupRoot, "payload/config/.env"), join(appRoot, ".env"));
  const workflowEnv = join(backupRoot, "payload/config/workflow.environment");
  rmSync(join(appRoot, "deploy/iva-workflow.environment"), { force: true });
  if (existsSync(workflowEnv)) copyPrivateTree(workflowEnv, join(appRoot, "deploy/iva-workflow.environment"));
  copyOptional(join(backupRoot, "payload/data"), dataDir);
  copyPrivateTree(join(backupRoot, "payload/vault"), vaultDir);

  if (metadata.source.profile === "postgres") {
    const dump = join(backupRoot, "payload/workflow/postgres.dump");
    must("pg_restore", ["--clean", "--if-exists", "--no-owner", "--no-privileges", "--dbname", postgresCompatibility.pgEnv.PGDATABASE, dump], {
      env: postgresCompatibility.pgEnv,
      inherit: true,
    });
  } else {
    copyPrivateTree(join(backupRoot, "payload/workflow/local"), workflowDir);
  }
  rmSync(join(vaultDir, ".index"), { recursive: true, force: true });
  rmSync(join(vaultDir, ".graph"), { recursive: true, force: true });
  return { metadata, profile: metadata.source.profile, dataDir, vaultDir, workflowDir };
}
