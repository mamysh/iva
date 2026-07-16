#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import {
  POSTGRES_DATABASE,
  POSTGRES_WORLD,
  choosePostgresCluster,
  evaluatePostgresPreflight,
  parsePostgresSchemaCheck,
  postgresEnvironmentText,
  postgresPeerUrl,
  postgresSchemaCheckSql,
  quotePostgresIdentifier,
  quotePostgresLiteral,
  selectPostgresSocketDirectory,
} from "./lib/postgres-profile.mjs";
import { resolveRuntimeWorkflowProfile } from "./lib/workflow-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const PROFILE_ENV_PATH = join(ROOT, "deploy/iva-workflow.environment");
const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function runtimeEnvironment() {
  const env = { ...process.env, ...readEnvFile(PROFILE_ENV_PATH), ...readEnvFile(ENV_PATH) };
  if (!env.PGCONNECT_TIMEOUT) env.PGCONNECT_TIMEOUT = "5";
  return env;
}

function execute(command, args = [], { capture = false, root = false, postgres = false, env } = {}) {
  let actualCommand = command;
  let actualArgs = args;
  if (postgres) {
    if (process.getuid?.() === 0) {
      actualCommand = "runuser";
      actualArgs = ["-u", "postgres", "--", command, ...args];
    } else {
      actualCommand = "sudo";
      actualArgs = ["-u", "postgres", command, ...args];
    }
  } else if (root && process.getuid?.() !== 0) {
    actualCommand = "sudo";
    actualArgs = [command, ...args];
  }
  return spawnSync(actualCommand, actualArgs, {
    cwd: ROOT,
    env: env || process.env,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function must(command, args = [], options = {}) {
  const result = execute(command, args, options);
  if ((result.status ?? 1) !== 0) {
    const detail = options.capture ? String(result.stderr || "").trim().split("\n").pop() : "";
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return options.capture ? String(result.stdout || "").trim() : "";
}

function commandExists(name) {
  return execute("sh", ["-c", `command -v ${name}`], { capture: true }).status === 0;
}

function memoryValue(name) {
  const match = readFileSync("/proc/meminfo", "utf8").match(new RegExp(`^${name}:\\s+(\\d+)`, "m"));
  return Math.floor(Number(match?.[1] || 0) / 1024);
}

function serviceUser() {
  return must("id", ["-un"], { capture: true });
}

function requireSudo() {
  if (process.getuid?.() === 0) return;
  if (!commandExists("sudo")) throw new Error("sudo is required to install and configure PostgreSQL");
  must("sudo", ["-v"]);
}

function runPreflight({ requireSystemd = true } = {}) {
  const disk = statfsSync(ROOT);
  const result = evaluatePostgresPreflight({
    platform: process.platform,
    osRelease: existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8") : "",
    memoryMb: memoryValue("MemTotal"),
    swapMb: memoryValue("SwapTotal"),
    diskFreeMb: Math.floor((disk.bavail * disk.bsize) / 1024 / 1024),
    serviceUser: serviceUser(),
  });
  if (!result.ok) throw new Error(`PostgreSQL preflight failed: ${result.issues.join("; ")}`);
  requireSudo();
  if (requireSystemd && execute("systemctl", ["--user", "show-environment"], { capture: true }).status !== 0) {
    throw new Error("systemd user services are unavailable; enable linger/login session and retry");
  }
  console.log(`PostgreSQL preflight: ${result.distro} ${result.version}, service user ${serviceUser()}`);
}

function installPostgresPackages() {
  if (commandExists("psql") && commandExists("pg_lsclusters")) return;
  console.log("Installing PostgreSQL packages…");
  must("apt-get", ["update"], { root: true, env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
  must("apt-get", ["install", "-y", "postgresql", "postgresql-client"], {
    root: true,
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" },
  });
}

function discoverCluster() {
  let cluster = choosePostgresCluster(must("pg_lsclusters", ["--no-header"], { capture: true }));
  if (!cluster) throw new Error("PostgreSQL installed but no cluster was created");
  if (cluster.status !== "online") {
    must("pg_ctlcluster", [cluster.version, cluster.name, "start"], { root: true });
    cluster = choosePostgresCluster(must("pg_lsclusters", ["--no-header"], { capture: true }));
  }
  if (!cluster || cluster.status !== "online") throw new Error("PostgreSQL cluster did not become online");
  return cluster;
}

function postgresAdminQuery(sql) {
  return must("psql", ["-AtX", "-d", "postgres", "-c", sql], { capture: true, postgres: true });
}

function installTuning(cluster) {
  const configFile = postgresAdminQuery("SHOW config_file");
  if (!configFile || !existsSync(configFile)) throw new Error("could not discover the active PostgreSQL config path");
  const targetDirectory = join(dirname(configFile), "conf.d");
  const target = join(targetDirectory, "iva.conf");
  const source = join(ROOT, "deploy/postgresql-iva.conf");
  const unchanged = existsSync(target) && execute("cmp", ["-s", source, target], { root: true, capture: true }).status === 0;
  if (unchanged) return configFile;
  must("mkdir", ["-p", targetDirectory], { root: true });
  must("install", ["-m", "0644", source, target], { root: true });
  must("pg_ctlcluster", [cluster.version, cluster.name, "restart"], { root: true });
  console.log(`PostgreSQL tuning installed beside active config (${configFile})`);
  return configFile;
}

function ensureRoleAndDatabase(owner) {
  const role = postgresAdminQuery(`SELECT 1 FROM pg_roles WHERE rolname=${quotePostgresLiteral(owner)}`);
  if (role !== "1") {
    must("createuser", ["--no-createdb", "--no-createrole", "--no-superuser", owner], { postgres: true });
    console.log(`PostgreSQL role created for service user ${owner}`);
  }
  const databaseOwner = postgresAdminQuery(
    `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=${quotePostgresLiteral(POSTGRES_DATABASE)}`,
  );
  if (!databaseOwner) {
    must("createdb", ["--owner", owner, POSTGRES_DATABASE], { postgres: true });
    console.log(`PostgreSQL database ${POSTGRES_DATABASE} created`);
  } else if (databaseOwner !== owner) {
    throw new Error(`database ${POSTGRES_DATABASE} already exists but is owned by another role`);
  }
}

function peerEnvironment(socketDirectory) {
  const generated = readEnvFileFromText(postgresEnvironmentText(socketDirectory));
  return { ...runtimeEnvironment(), ...generated };
}

function readEnvFileFromText(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

function assertPeerAuth(url, owner, env) {
  const currentUser = must("psql", [url, "-AtX", "-c", "SELECT current_user"], { capture: true, env });
  if (currentUser !== owner) throw new Error(`PostgreSQL peer auth resolved ${currentUser || "no user"}, expected ${owner}`);
}

function bootstrap(env) {
  must(process.execPath, [join(ROOT, "node_modules/@workflow/world-postgres/bin/setup.js")], { env });
}

function schemaStatus(env) {
  const url = env.WORKFLOW_POSTGRES_URL;
  if (!url) return { ok: false, missing: ["WORKFLOW_POSTGRES_URL"] };
  const journal = JSON.parse(
    readFileSync(join(ROOT, "node_modules/@workflow/world-postgres/src/drizzle/migrations/meta/_journal.json"), "utf8"),
  );
  const output = must("psql", [url, "-AtX", "-c", postgresSchemaCheckSql(journal.entries.length)], { capture: true, env });
  return parsePostgresSchemaCheck(output);
}

function workflowRunCount(env) {
  const table = must("psql", [env.WORKFLOW_POSTGRES_URL, "-AtX", "-c", "SELECT to_regclass('workflow.workflow_runs')"], {
    capture: true,
    env,
  });
  if (!table) return 0;
  const output = must("psql", [env.WORKFLOW_POSTGRES_URL, "-AtX", "-c", "SELECT count(*) FROM workflow.workflow_runs"], {
    capture: true,
    env,
  });
  return Number(output);
}

function writeProfileEnvironment(text) {
  mkdirSync(dirname(PROFILE_ENV_PATH), { recursive: true });
  const temporary = `${PROFILE_ENV_PATH}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, PROFILE_ENV_PATH);
  chmodSync(PROFILE_ENV_PATH, 0o600);
}

function runBuild(env) {
  must("npm", ["run", "build"], { env });
}

function systemctl(action, services = SERVICES) {
  must("systemctl", ["--user", action, ...services]);
}

async function waitForHealth(env, timeoutMs = 60_000) {
  const host = env.ASSISTANT_HOST || `http://127.0.0.1:${env.IVA_PORT || "8723"}`;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Client({ host }).health();
      return;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw new Error(`Eve readiness failed after PostgreSQL enable: ${lastError?.message || "health timeout"}`);
}

function runSmoke(mode, stateFile, env) {
  const args = [];
  if (existsSync(ENV_PATH)) args.push("--env-file=.env");
  args.push("scripts/workflow-smoke.mjs", mode);
  must(process.execPath, args, { env: { ...env, SMOKE_STATE: stateFile } });
}

function snapshotProfileEnvironment() {
  if (!existsSync(PROFILE_ENV_PATH)) return null;
  return { content: readFileSync(PROFILE_ENV_PATH), mode: statSync(PROFILE_ENV_PATH).mode & 0o777 };
}

function restoreProfileEnvironment(snapshot) {
  if (!snapshot) {
    rmSync(PROFILE_ENV_PATH, { force: true });
    return;
  }
  writeFileSync(PROFILE_ENV_PATH, snapshot.content, { mode: snapshot.mode });
  chmodSync(PROFILE_ENV_PATH, snapshot.mode);
}

async function enable({ serviceAcceptance = true } = {}) {
  const appSelector = readEnvFile(ENV_PATH).WORKFLOW_TARGET_WORLD;
  if (appSelector && appSelector !== POSTGRES_WORLD) {
    throw new Error(
      `.env sets WORKFLOW_TARGET_WORLD=${appSelector} and overrides the generated profile; ` +
        "remove that line before enabling PostgreSQL",
    );
  }
  runPreflight({ requireSystemd: serviceAcceptance });
  installPostgresPackages();
  const cluster = discoverCluster();
  const configFile = installTuning(cluster);
  console.log(`PostgreSQL cluster: ${cluster.version}/${cluster.name}; config: ${configFile}`);
  const owner = serviceUser();
  ensureRoleAndDatabase(owner);
  const socketDirectory = selectPostgresSocketDirectory(postgresAdminQuery("SHOW unix_socket_directories"));
  const environmentText = postgresEnvironmentText(socketDirectory);
  const env = peerEnvironment(socketDirectory);
  const peerUrl = postgresPeerUrl(socketDirectory);
  assertPeerAuth(peerUrl, owner, env);

  const originalProfile = resolveRuntimeWorkflowProfile(ROOT).profile.backend;
  const originalEnvironment = snapshotProfileEnvironment();
  const localStateExisted = existsSync(join(ROOT, ".workflow-data"));
  let profileWritten = false;
  const smokeState = join("/tmp", `iva-workflow-smoke-${process.getuid?.() ?? "user"}.json`);
  try {
    if (serviceAcceptance) systemctl("stop");
    writeProfileEnvironment(environmentText);
    profileWritten = true;
    bootstrap(env);
    const schema = schemaStatus(env);
    if (!schema.ok) throw new Error(`PostgreSQL bootstrap incomplete: missing ${schema.missing.join(", ")}`);
    runBuild(env);
    if (!serviceAcceptance) {
      console.log("PostgreSQL workflow profile prepared: peer auth, bootstrap, schema and build passed");
      return;
    }
    must(process.execPath, ["bin/iva.mjs", "_install-units"], { env });
    systemctl("restart");
    await waitForHealth(env);
    runSmoke("seed", smokeState, env);
    systemctl("restart");
    await waitForHealth(env);
    runSmoke("resume", smokeState, env);
    if (!localStateExisted && existsSync(join(ROOT, ".workflow-data"))) {
      throw new Error("PostgreSQL profile started but local .workflow-data was created");
    }
    console.log("PostgreSQL workflow profile enabled: bootstrap, readiness and restart/resume passed");
  } catch (error) {
    let runCount = Number.POSITIVE_INFINITY;
    try {
      runCount = workflowRunCount(env);
    } catch {}
    if (profileWritten && originalProfile === "local" && runCount === 0) {
      console.error("PostgreSQL enable failed before user sessions were created; restoring the local profile…");
      if (serviceAcceptance) systemctl("stop");
      restoreProfileEnvironment(originalEnvironment);
      if (serviceAcceptance) {
        const restoredEnv = runtimeEnvironment();
        runBuild(restoredEnv);
        systemctl("restart");
      }
      console.error("Local profile restored. PostgreSQL database was kept for diagnosis.");
    } else {
      console.error("PostgreSQL database and profile were kept; no automatic destructive rollback was attempted.");
    }
    throw error;
  } finally {
    rmSync(smokeState, { force: true });
  }
}

function check() {
  const env = runtimeEnvironment();
  const status = schemaStatus(env);
  if (!status.ok) throw new Error(`schema incomplete: missing ${status.missing.join(", ")}`);
  console.log("PostgreSQL workflow schema ready");
}

async function main() {
  const command = process.argv[2];
  if (command === "enable") return enable();
  if (command === "prepare") return enable({ serviceAcceptance: false });
  if (command === "check") return check();
  throw new Error("usage: postgres-profile.mjs <enable|check>");
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
