#!/usr/bin/env node
// Iva CLI — manage the self-host installation: update / config / doctor / uninstall + wrappers.
// Self-contained, no external dependencies. Node 24+ (global fetch, spawnSync).
//
// SINGLE source of truth for systemd units (writeUnits): install.sh delegates here
// (`iva _install-units`), and update/doctor reuse the same write.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { resolveRuntimeWorkflowProfile } from "../scripts/lib/workflow-runtime.mjs";
import { resolveUpdateChannel, updateChannelRef } from "../scripts/lib/update-channel.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = join(ROOT, ".env");
const WORKFLOW_ENV_PATH = join(ROOT, "deploy/iva-workflow.environment");
const UNIT_DIR = join(homedir(), ".config/systemd/user");
const NODE = process.execPath;
const NODE_BIN_DIR = dirname(NODE);
const NPM = existsSync(join(NODE_BIN_DIR, "npm")) ? join(NODE_BIN_DIR, "npm") : "npm";
// Children inherit PATH with the node directory — otherwise npm/eve won't be found when called via wrapper.
const childEnv = { ...process.env, PATH: `${NODE_BIN_DIR}:${process.env.PATH || ""}` };

const SERVICES = ["iva.service", "iva-telegram-poll.service"];
const MEMORY_TIMERS = ["daily", "weekly", "monthly", "yearly", "doctor"].map((n) => `iva-memory-${n}.timer`);
const TIMERS = [...MEMORY_TIMERS, "iva-reminders.timer", "iva-observe.timer"];

// Telegram userbot proxy — OPT-IN (not in SERVICES, so `iva update` never tries to start
// it without API creds). Enabled explicitly via `iva userbot setup`.
const SVC_USERBOT = "iva-telegram-userbot.service";
const USERBOT_DIR = join(ROOT, "services/telegram-userbot");
const VENV_PY = join(USERBOT_DIR, ".venv/bin/python");
// Proxy bearer secret. A FILE (not .env) read at runtime by both the proxy and iva's
// connection, so iva needn't restart after the agent sets the proxy up mid-chat.
const userbotTokenFile = () => join(dataDirAbs(), "telegram-userbot.token");

// Uncommon default port: 3000/8000/8080 are typically taken on a VPS (docker, etc.).
// Overridden by the IVA_PORT variable in .env; the default ASSISTANT_HOST depends on it too.
const DEFAULT_PORT = "8723";
// Former (hardcoded) default before the switch to IVA_PORT — needed to migrate old .env files.
const OLD_DEFAULT_HOST = "http://127.0.0.1:3000";

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", b: "\x1b[1m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const bad = (m) => console.log(`${C.r}✗${C.x} ${m}`);
const step = (m) => console.log(`${C.b}${C.c}▸ ${m}${C.x}`);

// ── small helpers ────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: childEnv, ...opts });
}
function cap(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: childEnv, ...opts });
  return { code: r.status ?? 1, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
const hasSystemd = () => !!cap("sh", ["-c", "command -v systemctl"]).out;
const sc = (...args) => run("systemctl", ["--user", ...args]);
const scQ = (...args) => cap("systemctl", ["--user", ...args]);
const gitHead = () => cap("git", ["rev-parse", "--short", "HEAD"]).out;

function readEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

function readEnv() {
  return readEnvFile(ENV_PATH);
}

// Абсолютный путь к каталогу data (тот же, что видит агент из cwd=ROOT). Абсолютный
// ASSISTANT_DATA_DIR берём как есть, относительный — от ROOT (как vault-путь ниже).
function dataDirAbs(env = readEnv()) {
  const d = env.ASSISTANT_DATA_DIR || "data";
  return d.startsWith("/") ? d : join(ROOT, d);
}

async function confirm(question, def = false) {
  if (!process.stdin.isTTY) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith("y") : def;
}

function requireSystemd() {
  if (!hasSystemd()) {
    bad("systemd unavailable — this command only works on a Linux server");
    process.exit(1);
  }
}

async function notifyTelegram(text) {
  const env = readEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_DIGEST_CHAT_ID || (env.TELEGRAM_ALLOWED_USER_IDS || "").split(",")[0];
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch {}
}

// ── systemd units: single source of truth ─────────────────────────────────
function ivaServiceBody() {
  // PATH with the node directory (= npm global bin under nvm); bounded retries avoid restart storms.
  const port = (readEnv().IVA_PORT || DEFAULT_PORT).trim();
  return [
    "[Unit]",
    "Description=Iva",
    "After=network-online.target",
    "StartLimitIntervalSec=5min",
    "StartLimitBurst=5",
    "",
    "[Service]",
    `WorkingDirectory=${ROOT}`,
    `EnvironmentFile=-${WORKFLOW_ENV_PATH}`,
    `EnvironmentFile=${ROOT}/.env`,
    // Стартуем через `eve start`, а НЕ напрямую `node .output/server/index.mjs`: eve start
    // вызывает prewarmBuiltAppSandboxes() и собирает шаблон песочницы ДО приёма трафика. Сырой
    // index.mjs prewarm не делает → первое же вложение падает SandboxTemplateNotProvisionedError
    // (шаблона нет в .eve/sandbox-cache). Ключ шаблона — контент-хеш, после iva update он меняется,
    // поэтому provision обязан идти на каждом старте, а не разово. eve start остаётся foreground.
    `ExecStart=${NODE} ${ROOT}/scripts/start.mjs`,
    `Environment=PORT=${port}`,
    `Environment=PATH=${NODE_BIN_DIR}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    "Environment=AGENT_BROWSER_MAX_OUTPUT=24000",
    "Restart=on-failure",
    "RestartSec=10s",
    "TimeoutStopSec=15s",
    "SendSIGKILL=yes",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function writeUnitIfChanged(path, body) {
  if (existsSync(path) && readFileSync(path, "utf8") === body) return false;
  writeFileSync(path, body);
  return true;
}

// Writes iva.service + all deploy/iva-*.{service,timer} with placeholder substitution.
// Avoid touching identical units: reloading rewritten inactive oneshots makes systemd forget their
// last successful execution timestamps, which in turn creates false doctor/backup warnings.
function writeUnits() {
  mkdirSync(UNIT_DIR, { recursive: true });
  let changed = writeUnitIfChanged(join(UNIT_DIR, "iva.service"), ivaServiceBody());
  const written = ["iva.service"];
  const deploy = join(ROOT, "deploy");
  for (const f of readdirSync(deploy)) {
    if (!/^iva-.*\.(service|timer)$/.test(f)) continue;
    const tpl = readFileSync(join(deploy, f), "utf8")
      .replaceAll("__PROJECT_DIR__", ROOT)
      .replaceAll("__NODE_BIN__", NODE)
      .replaceAll("__PYTHON_BIN__", VENV_PY);
    changed = writeUnitIfChanged(join(UNIT_DIR, f), tpl) || changed;
    written.push(f);
  }
  if (changed && hasSystemd()) scQ("daemon-reload");
  return written;
}

function enableUnits() {
  sc("enable", "--now", ...SERVICES);
  for (const t of TIMERS) sc("enable", "--now", t);
}

function removeUnits() {
  if (!existsSync(UNIT_DIR)) return [];
  const units = readdirSync(UNIT_DIR).filter((f) => /^iva.*\.(service|timer)$/.test(f));
  for (const u of units) scQ("disable", "--now", u);
  for (const u of units) {
    try {
      rmSync(join(UNIT_DIR, u));
    } catch {}
  }
  scQ("daemon-reload");
  scQ("reset-failed");
  return units;
}

// Migrate old installs to IVA_PORT. Idempotent: on the first `iva update`
// after switching to the new scheme it guarantees the variable and keeps the server
// (Environment=PORT=$IVA_PORT) from drifting away from clients (whose default is ASSISTANT_HOST).
function migrateEnv() {
  if (!existsSync(ENV_PATH)) return false;
  const env = readEnv();
  if (env.IVA_PORT) return false; // already on the new scheme — leave it alone
  const host = env.ASSISTANT_HOST || "";
  const local = host.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/i);
  const isOldDefault = host === OLD_DEFAULT_HOST;
  // old default :3000 → new default 8723; custom local host → its port; otherwise the default
  const port = isOldDefault ? DEFAULT_PORT : local ? local[1] : DEFAULT_PORT;
  let raw = readFileSync(ENV_PATH, "utf8").replace(/\n*$/, "\n") + `IVA_PORT=${port}\n`;
  // don't leave a stale :3000 in ASSISTANT_HOST — otherwise clients get stuck on the taken port
  if (isOldDefault) raw = raw.replace(/^(\s*ASSISTANT_HOST\s*=).*$/m, `$1http://127.0.0.1:${port}`);
  writeFileSync(ENV_PATH, raw);
  ok(`.env migrated → IVA_PORT=${port}${isOldDefault ? ", ASSISTANT_HOST moved off :3000" : ""}`);
  return true;
}

// Any restart via `iva` first regenerates the unit → Environment=PORT always equals
// the current IVA_PORT from .env. Without this, editing IVA_PORT + restart would leave the server
// on the old port (the unit was already baked) while clients read the new one — the same desync.
function restartServices() {
  writeUnits();
  for (const timer of TIMERS) {
    if (scQ("is-enabled", timer).out !== "enabled") sc("enable", "--now", timer);
  }
  sc("restart", ...SERVICES);
}

// ANSI tree like during install. The only source of the art is install.sh (heredoc
// IVA_TREE); we read it from there so as not to spawn a copy. In a real terminal we add
// a little "life": the crown sways in the wind, colors shimmer, glyphs breathe slightly.
// Non-TTY / narrow window / IVA_NO_ANIM / any failure — a static frame (or nothing).
const TREE_RAMP = " .:;!icoa*xw#%$&@"; // the same set as the art generator

// Parse the heredoc into a grid of cells: {ch,r,g,b} for a colored glyph, {ch:" ",bg} for background.
function loadTreeGrid() {
  const sh = readFileSync(join(ROOT, "install.sh"), "utf8");
  const body = sh.split("<<'IVA_TREE'\n")[1]?.split("\nIVA_TREE")[0];
  if (!body) return null;
  const re = /\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S])|\x1b\[0m|([\s\S])/g;
  return body.replace(/\\033/g, "\x1b").split("\n").map((line) => {
    const cells = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      if (m[4] !== undefined) cells.push({ ch: m[4], r: +m[1], g: +m[2], b: +m[3] });
      else if (m[5] !== undefined) cells.push({ ch: m[5], bg: true });
    }
    return cells;
  });
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// One frame. live=false → reference (no sway/shimmer) for the final resting state.
function renderTreeFrame(grid, t, live) {
  const rows = grid.length;
  let out = "";
  for (let y = 0; y < rows; y++) {
    const cells = grid[y];
    let lead = 0;
    while (lead < cells.length && cells[lead].bg) lead++;
    let last = cells.length - 1;
    while (last >= 0 && cells[last].bg) last--;
    // the tree stays still — only the glyphs and their colors come alive
    let line = " ".repeat(lead);
    for (let x = lead; x <= last; x++) {
      const c = cells[x];
      if (c.bg) { line += " "; continue; }
      let { r, g, b, ch } = c;
      if (live) {
        const shim = 1 + 0.16 * Math.sin(t * 0.6 + x * 0.45 + y * 0.3); // brightness shimmer
        r = clampByte(Math.round(r * shim));
        g = clampByte(Math.round(g * shim));
        b = clampByte(Math.round(b * shim));
        const idx = TREE_RAMP.indexOf(ch); // glyph breathes ±1 along the ramp (not into background)
        if (idx > 0) ch = TREE_RAMP[clamp(idx + Math.round(0.9 * Math.sin(t * 0.5 + x * 0.7 + y * 1.1)), 1, TREE_RAMP.length - 1)];
      }
      line += `\x1b[38;2;${r};${g};${b}m${ch}`;
    }
    out += line + "\x1b[0m\x1b[K\n";
  }
  return out;
}

async function showTree() {
  if (!process.stdout.isTTY) return;
  try {
    const grid = loadTreeGrid();
    if (!grid) return;
    const rows = grid.length;
    const width = Math.max(...grid.map((r) => r.length)) + 3;
    process.stdout.write("\n");
    // a narrow window breaks cursor-based redraw — show it statically
    if ((process.stdout.columns || 80) < width || process.env.IVA_NO_ANIM) {
      process.stdout.write(renderTreeFrame(grid, 0, false) + "\n");
      return;
    }
    process.stdout.write("\x1b[?25l"); // hide the cursor
    const FRAMES = 36, DELAY = 70;
    for (let f = 0; f < FRAMES; f++) {
      if (f > 0) process.stdout.write(`\x1b[${rows}A`);
      process.stdout.write(renderTreeFrame(grid, f * 0.7, true));
      await new Promise((r) => setTimeout(r, DELAY));
    }
    process.stdout.write(`\x1b[${rows}A` + renderTreeFrame(grid, 0, false) + "\x1b[?25h\n");
  } catch {
    process.stdout.write("\x1b[?25h"); // just in case — restore the cursor
  }
}

// ── commands ───────────────────────────────────────────────────────────────
async function cmdUpdate(args) {
  const force = args.includes("--force");
  const telegramJobId = args.find((arg) => arg.startsWith("--telegram-job="))?.slice("--telegram-job=".length) || null;
  const { createTelegramUpdateReporter, loadTelegramUpdateJob, removeTelegramUpdateJob } = await import("../scripts/lib/update-progress.mjs");
  const telegramJob = telegramJobId ? loadTelegramUpdateJob(dataDirAbs(), telegramJobId) : null;
  const reporter = telegramJob ? createTelegramUpdateReporter({
    token: readEnv().TELEGRAM_BOT_TOKEN,
    job: telegramJob.job,
  }) : null;
  await showTree();
  step("Updating Iva…");
  const { performUpdate } = await import("../scripts/update-runtime.mjs");
  let result;
  try {
    try {
      result = await performUpdate({
        force,
        log: (message) => console.log(message),
        onProgress: (phase) => reporter?.phase(phase),
        lockSource: telegramJobId ? "telegram" : "cli",
      });
    } catch (error) {
      result = { outcome: "rolled_back", reason: error?.message || String(error) };
    }
    await reporter?.complete(result);
    if (result.outcome === "current") {
      ok(`Already up to date (${result.currentCommit.slice(0, 7)}). Nothing to rebuild (--force to force it).`);
      return;
    }
    if (result.outcome === "updated") {
      ok(`UPDATED: ${result.currentCommit.slice(0, 7)} → ${result.targetCommit.slice(0, 7)}`);
      if (!telegramJobId) await notifyTelegram(`✅ Iva updated: ${result.currentCommit.slice(0, 7)} → ${result.targetCommit.slice(0, 7)}`);
      return;
    }
    if (result.outcome === "blocked") {
      warn("Update already in progress; this request did not start a second transaction.");
      process.exitCode = 2;
      return;
    }
    bad(`ROLLED BACK: ${result.reason}. Previous version is active.`);
    if (!telegramJobId) await notifyTelegram(`↩️ Iva update rolled back: ${result.reason}. Previous version is active.`);
    process.exitCode = 1;
  } finally {
    if (telegramJob) removeTelegramUpdateJob(telegramJob.path);
  }
}

async function cmdBackup(args) {
  const destination = args.find((arg) => !arg.startsWith("--"));
  step("Creating a verified portable backup…");
  const { performBackup } = await import("../scripts/backup-runtime.mjs");
  const result = performBackup({ destination, log: (message) => console.log(message) });
  ok(`Backup ready: ${result.path}`);
  console.log(`${C.d}Copy this private directory off the host; files are 0600 and directories are 0700.${C.x}`);
}

async function cmdRestore(args) {
  const source = args.find((arg) => !arg.startsWith("--"));
  if (!source) {
    bad("Usage: iva restore <portable-backup-directory> [--yes]");
    process.exit(1);
  }
  warn("Restore replaces configuration, vault, application data and Workflow state.");
  const confirmed = args.includes("--yes") || await confirm("Restore into this installed Iva root?", false);
  if (!confirmed) return warn("Restore cancelled; no state changed");
  step("Verifying and restoring portable backup…");
  const { performRestore } = await import("../scripts/backup-runtime.mjs");
  const result = performRestore({ backupDir: source, confirmed: true, log: (message) => console.log(message) });
  ok(`Restore complete: ${result.profile} state and production build verified`);
  warn("Services remain stopped to prevent duplicate Telegram polling during a move.");
  console.log("After the old host is stopped, run: iva start");
  if (existsSync(join(dataDirAbs(), "telegram-userbot.session"))) {
    console.log("Userbot session was restored but stays opt-in; enable it explicitly with: iva userbot setup");
  }
}

async function cmdConfig() {
  const r = run(NODE, ["scripts/setup.mjs"]);
  if (r.status !== 0) process.exit(r.status ?? 1);
  if (hasSystemd() && (await confirm("Restart services to apply the settings?", true))) {
    restartServices(); // setup may have changed IVA_PORT → regenerate the unit, otherwise the server stays on the old port
    ok("Services restarted");
  }
}

function cmdDoctor(args) {
  const json = args.includes("--json");
  const fixed = [];
  if (!json) {
    if (migrateEnv()) fixed.push("configuration.required");
    if (!existsSync(join(ROOT, ".output/server/index.mjs"))) {
      step("Production build is missing — building…");
      if (run(NPM, ["run", "build"]).status === 0) fixed.push("build.output");
    }
    if (hasSystemd()) {
      const present = existsSync(UNIT_DIR) && readdirSync(UNIT_DIR).some((file) => /^iva.*\.(service|timer)$/.test(file));
      writeUnits();
      if (!present) enableUnits();
      for (const service of SERVICES) {
        if (scQ("is-active", service).out === "active") continue;
        scQ("reset-failed", service);
        sc("restart", service);
        if (scQ("is-active", service).out === "active") {
          fixed.push(service === "iva.service" ? "services.agent" : "services.bridge");
        }
      }
      let timerFixed = false;
      for (const timer of TIMERS) {
        if (scQ("is-enabled", timer).out === "enabled") continue;
        sc("enable", "--now", timer);
        timerFixed = true;
      }
      if (timerFixed) fixed.push("services.timers");
    }
  }
  const result = run(NODE, ["scripts/doctor.mjs", ...(json ? ["--json"] : [])], {
    env: { ...childEnv, IVA_DOCTOR_FIXED: fixed.join(",") },
  });
  process.exit(result.status ?? 1);
}

function cmdStatus() {
  const { profile } = resolveRuntimeWorkflowProfile(ROOT);
  console.log(`Workflow: ${profile.label}`);
  try {
    const info = resolveUpdateChannel({ dataDir: dataDirAbs(), runGit: (args) => cap("git", args) });
    console.log(`Update channel: ${updateChannelRef(info.channel)}${info.migrated ? " (legacy install pinned)" : ""}`);
  } catch (error) {
    console.log(`Update channel: blocked (${error.message})`);
  }
  run(NODE, ["scripts/observe.mjs", "status"]);
  requireSystemd();
  console.log(`Services: agent ${scQ("is-active", SERVICES[0]).out || "unknown"} · Telegram ${scQ("is-active", SERVICES[1]).out || "unknown"}`);
  console.log(`Collector: ${scQ("is-enabled", "iva-observe.timer").out || "disabled"}`);
}
function cmdRestart() {
  requireSystemd();
  restartServices(); // regenerate the unit before restart → PORT stays in sync with IVA_PORT in .env
  ok("Restarted: iva + telegram-poll");
}
function cmdRecover() {
  requireSystemd();
  const health = cap(NODE, ["scripts/workflow-health.mjs", "status", "--json"]);
  let report;
  try { report = JSON.parse(health.out); } catch {}
  if (!report?.available) {
    bad(`Recovery paused: ${report?.error || health.err || "workflow storage is unavailable"}`);
    warn("No state was changed. Restore storage access, then run: iva recover");
    process.exit(1);
  }
  if ((report.states?.wedged || 0) > 0) {
    warn(`${report.states.wedged} wedged workflow run(s) detected; they will be repaired, not deleted`);
  }
  sc("stop", "iva.service");
  const repair = run(NODE, ["scripts/workflow-health.mjs", "repair"]);
  if (repair.status !== 0) {
    sc("start", "iva.service");
    bad("Recovery repair failed; the agent was brought back with state preserved");
    process.exit(1);
  }
  scQ("reset-failed", ...SERVICES);
  restartServices();
  const reenqueue = run(NODE, ["scripts/workflow-health.mjs", "reenqueue"]);
  if (reenqueue.status !== 0) {
    bad("Services restarted, but durable runs could not be re-enqueued; state remains preserved");
    process.exit(1);
  }
  ok("Recovery completed: storage was ready; services restarted without deleting workflow state");
}

// Explicitly cancel active runs through the Workflow event API on either backend. Terminal history,
// streams, the vault and application data remain intact. This is intentionally not a purge.
async function cmdReset(args) {
  requireSystemd();
  if (!args.includes("--yes") && !(await confirm("Cancel every active workflow session and restart Iva?", false))) {
    warn("Reset cancelled; no state changed");
    return;
  }
  step("Stopping the agent before workflow cancellation…");
  sc("stop", "iva.service");
  const reset = run(NODE, ["scripts/workflow-health.mjs", "reset"]);
  if (reset.status !== 0) {
    sc("start", "iva.service");
    bad("Workflow reset failed; the agent was brought back without deleting state");
    process.exit(1);
  }
  sc("start", "iva.service");
  ok("Reset complete: active runs cancelled; durable history and user data preserved");
}
function cmdStart() {
  requireSystemd();
  enableUnits();
  ok("Started and enabled at boot");
}
function cmdStop() {
  requireSystemd();
  sc("stop", ...SERVICES);
  ok("Stopped");
}
function cmdLogs(args) {
  requireSystemd();
  const unit = args.includes("poll")
    ? "iva-telegram-poll.service"
    : args.includes("reminders")
      ? "iva-reminders.service"
      : "iva.service";
  run("journalctl", ["--user", "-u", unit, "-f", "-n", "50"]);
}

async function cmdUninstall(args) {
  const purge = args.includes("--purge");
  warn("Uninstalling Iva: systemd units and the `iva` command will be removed.");
  if (purge) bad("--purge will ALSO DELETE the project code and vault (a separate git repo with your memory!).");
  if (!(await confirm("Continue?", false))) return console.log("Cancelled.");

  if (hasSystemd()) ok(`Removed systemd units: ${removeUnits().length}`);
  try {
    rmSync(join(homedir(), ".local/bin/iva"));
    ok("iva command removed from ~/.local/bin");
  } catch {}

  if (!purge) {
    console.log(`${C.d}Code and vault kept: ${ROOT}${C.x}`);
    return ok("Done.");
  }
  if (!(await confirm(`Delete the ${ROOT} directory AND vault IRREVERSIBLY?`, false)))
    return console.log("Code and vault kept.");
  const vaultRel = readEnv().ASSISTANT_VAULT_DIR || "vault";
  const vaultPath = vaultRel.startsWith("/") ? vaultRel : join(ROOT, vaultRel);
  for (const [p, label] of [
    [vaultPath, "vault"],
    [ROOT, "code"],
  ]) {
    try {
      rmSync(p, { recursive: true, force: true });
      ok(`${label} deleted`);
    } catch (e) {
      warn(`did not delete ${label}: ${e.message}`);
    }
  }
}

function cmdVersion() {
  let v = "?";
  try {
    v = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {}
  console.log(`iva ${v} · commit ${gitHead() || "?"}`);
}

// Token usage from data/usage.jsonl — the same log that Telegram /usage reads. A terminal
// view (issue #7, the comment about a CLI monitor). `tail [N]` — the last raw lines.
async function cmdUsage(args) {
  const { readEntries, summarize, formatUsageReport, parseWindow } = await import("../scripts/lib/usage.mjs");
  const env = readEnv();
  const dataDir = join(ROOT, env.ASSISTANT_DATA_DIR || "data");
  if (args[0] === "tail") {
    const n = Number(args[1]) || 10;
    for (const e of readEntries(dataDir).slice(-n)) console.log(JSON.stringify(e));
    return;
  }
  const agg = summarize(readEntries(dataDir), { window: parseWindow(args[0]), now: Date.now(), tz: env.ASSISTANT_TIMEZONE });
  console.log(formatUsageReport(agg));
}

function cmdReminders() {
  const r = run(NODE, ["--env-file=.env", "scripts/reminders-run.mjs", "--list"]);
  process.exit(r.status ?? 1);
}

function cmdWorkflowSmoke(args) {
  const mode = args[0];
  if (mode !== "seed" && mode !== "resume") {
    console.log("Usage: iva workflow-smoke seed");
    console.log("       iva workflow-smoke resume");
    return;
  }
  const r = run(NODE, ["--env-file=.env", "scripts/workflow-smoke.mjs", mode]);
  process.exit(r.status ?? 1);
}

function cmdWorkflowPostgres(args) {
  const subcommand = args[0] || "enable";
  if (subcommand !== "enable") {
    console.log("Usage: iva workflow-postgres enable");
    return;
  }
  const result = run(NODE, ["scripts/postgres-profile.mjs", "enable"]);
  process.exit(result.status ?? 1);
}

// OpenAI subscription (ChatGPT) login — device code by default, --browser for the PKCE flow.
// Writes an OAuth token to data/codex-auth.json (0600); used when MODEL_PROVIDER=codex.
async function cmdLogin(args) {
  const { runDeviceCodeLogin, runBrowserLogin } = await import("../scripts/lib/codex-oauth.mjs");
  const dataDir = dataDirAbs();
  const lang = (readEnv().AGENT_LANGUAGE || "en").toLowerCase();
  const browser = args.includes("--browser");
  step(browser ? "OpenAI sign-in (browser)…" : "OpenAI sign-in (device code)…");
  try {
    const auth = browser
      ? await runBrowserLogin({ dataDir, lang, log: (m) => console.log(m) })
      : await runDeviceCodeLogin({ dataDir, lang, log: (m) => console.log(m) });
    ok(`Signed in${auth.planType ? ` — plan: ${auth.planType}` : ""}${auth.accountId ? ` · account ${auth.accountId}` : ""}`);
    console.log(`${C.d}Token stored: ${join(dataDir, "codex-auth.json")} (chmod 600)${C.x}`);
    if (readEnv().MODEL_PROVIDER !== "codex") warn("Set MODEL_PROVIDER=codex to use it: iva config (then iva restart)");
  } catch (e) {
    bad(`Sign-in failed: ${e.message}`);
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`
${C.b}Iva CLI${C.x} — manage your personal agent

${C.b}Commands:${C.x}
  ${C.c}iva update${C.x}         update: git pull + build + restart
  ${C.c}iva backup${C.x} [dir]   create and verify a private portable backup directory
  ${C.c}iva restore${C.x} <dir>  restore on a clean host (confirmation required; services stay stopped)
  ${C.c}iva config${C.x}         configure: model, Telegram, Deepgram, TZ, vault
  ${C.c}iva login${C.x} [--browser]  sign in to an OpenAI subscription (ChatGPT) for MODEL_PROVIDER=codex
  ${C.c}iva doctor${C.x}         diagnose and safely auto-repair the install
  ${C.c}iva status${C.x}         concise health, growth and capacity summary
  ${C.c}iva restart${C.x}        restart the agent and Telegram bridge
  ${C.c}iva recover${C.x}        diagnose and safely restart without deleting workflow state
  ${C.c}iva reset${C.x}          cancel all active workflow sessions (confirmation required)
  ${C.c}iva workflow-smoke${C.x} seed|resume  verify workflow session survives restart
  ${C.c}iva workflow-postgres${C.x} enable  install and verify the durable PostgreSQL profile (advanced)
  ${C.c}iva start${C.x} / ${C.c}stop${C.x}    start / stop
  ${C.c}iva reminders${C.x}    show active reminders
  ${C.c}iva usage${C.x} [win]      token usage (last|today|week|month|by-model|by-source|tail)
  ${C.c}iva userbot${C.x} [creds|setup|status|off]  personal-account userbot proxy (Telegram, opt-in)
  ${C.c}iva logs${C.x} [poll|reminders] agent, Telegram bridge, or reminders logs -f
  ${C.c}iva uninstall${C.x}       remove units and the command (--purge — delete code+vault)
  ${C.c}iva version${C.x}         version and git commit

  ${C.d}flags: update --force — rebuild with no changes${C.x}
`);
}

// ── router ──────────────────────────────────────────────────────────────────
// ── Telegram userbot (opt-in) ────────────────────────────────────────────
// Build the venv if missing and ALWAYS sync deps (idempotent), then verify the
// critical imports actually resolve. Throws on any failure so the caller aborts
// BEFORE enabling a service that would restart-loop on a partial install.
function ensureUserbotVenv() {
  const hasUv = !!cap("sh", ["-c", "command -v uv"]).out;
  const opts = { cwd: USERBOT_DIR };
  const must = (r, what) => {
    if ((r?.status ?? 1) !== 0) throw new Error(`userbot: ${what} не удалось`);
  };
  if (!existsSync(VENV_PY)) {
    step("Создаю venv для userbot-прокси…");
    must(
      hasUv ? run("uv", ["venv", "--python", "3.12", ".venv"], opts) : run("python3", ["-m", "venv", ".venv"], opts),
      "создание venv",
    );
    if (!existsSync(VENV_PY)) throw new Error("userbot: venv не создан — проверь python3/uv");
  }
  step("Синхронизирую зависимости userbot-прокси…");
  if (hasUv) {
    must(run("uv", ["pip", "install", "--python", VENV_PY, "-r", "requirements.txt"], opts), "установка зависимостей");
  } else {
    must(run(VENV_PY, ["-m", "pip", "install", "-q", "-U", "pip"], opts), "обновление pip");
    must(run(VENV_PY, ["-m", "pip", "install", "-q", "-r", "requirements.txt"], opts), "установка зависимостей");
  }
  // A partial install imports-fails at runtime → the service restart-loops silently.
  const check = cap(VENV_PY, ["-c", "import telethon, telegram_mcp, qrcode, mcp"], opts);
  if (check.code !== 0)
    throw new Error(`userbot: зависимости не импортируются — ${check.err.split("\n").pop() || "проверь requirements"}`);
}

// Update-or-append keys in .env (dedup). Used to write Telegram api_id/api_hash
// without the agent hand-editing .env or leaking secrets through argv.
function writeEnvVars(vars) {
  let raw = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  for (const [k, v] of Object.entries(vars)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^\\s*${k}\\s*=.*$`, "m");
    raw = re.test(raw) ? raw.replace(re, line) : raw.replace(/\n*$/, "\n") + line + "\n";
  }
  writeFileSync(ENV_PATH, raw);
}

// Generate the proxy bearer once, into a 0600 file both sides read at runtime.
function ensureUserbotToken() {
  const tokenFile = userbotTokenFile();
  if (existsSync(tokenFile)) return;
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
  try {
    chmodSync(tokenFile, 0o600);
  } catch {}
  ok("Сгенерировал токен прокси (data/telegram-userbot.token).");
}

// Restart the opt-in proxy onto fresh code/deps, but ONLY if it's already active
// (never auto-start it for users who didn't opt in). Called from `iva update`.
function restartUserbotIfActive() {
  if (scQ("is-active", SVC_USERBOT).out !== "active") return;
  step("Обновляю userbot-прокси…");
  try {
    ensureUserbotVenv();
  } catch (e) {
    warn(e.message);
  }
  sc("restart", SVC_USERBOT); // writeUnits already ran in restartServices()
  ok("userbot-прокси перезапущен на новом коде");
}

function cmdUserbot(args) {
  const sub = args[0] || "status";
  if (sub === "creds") {
    // Read api_id + api_hash from STDIN (two lines) — keeps secrets out of argv/ps.
    // Usage (agent): `iva userbot creds <<'CREDS'\n<api_id>\n<api_hash>\nCREDS`
    let data = "";
    try {
      data = readFileSync(0, "utf8");
    } catch {}
    const [apiId, apiHash] = data
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!apiId || !apiHash) {
      bad("stdin: жду две строки — api_id и api_hash (создай приложение на my.telegram.org)");
      process.exit(1);
    }
    if (!/^\d+$/.test(apiId)) {
      bad("api_id должен быть числом");
      process.exit(1);
    }
    writeEnvVars({ TELEGRAM_API_ID: apiId, TELEGRAM_API_HASH: apiHash });
    ok("Ключи Telegram записаны в .env. Теперь: iva userbot setup");
    return;
  }
  if (sub === "setup") {
    const env = readEnv();
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
      bad("Нет TELEGRAM_API_ID/TELEGRAM_API_HASH в .env. Создай приложение на my.telegram.org,");
      bad("впиши оба ключа в .env и запусти снова: iva userbot setup");
      process.exit(1);
    }
    ensureUserbotToken(); // 0600 token file both the proxy and iva's connection read at runtime
    ensureUserbotVenv(); // throws → dispatch catches → exit 1, service NOT enabled
    writeUnits();
    sc("enable", SVC_USERBOT);
    sc("restart", SVC_USERBOT); // restart (not just enable --now) so a rewritten unit / new creds load
    // NOTE: do NOT restart iva here — the agent runs this mid-chat, and iva reads the token
    // from the file at call time, so no restart is needed (Eve retries the MCP connection).
    ok("Userbot-прокси включён. Подключи аккаунт по QR через бота: напиши боту «подключи мой телеграм».");
    ok("Статус: iva userbot status · выключить: iva userbot off");
    return;
  }
  if (sub === "off") {
    scQ("disable", "--now", SVC_USERBOT);
    ok("Userbot-прокси остановлен и выключен.");
    return;
  }
  const active = scQ("is-active", SVC_USERBOT).out || "не установлен";
  const enabled = scQ("is-enabled", SVC_USERBOT).out || "-";
  console.log(`${SVC_USERBOT}: ${active} (${enabled})`);
  console.log(`venv: ${existsSync(VENV_PY) ? "собран" : "нет — будет собран при setup"}`);
  console.log(`токен: ${existsSync(userbotTokenFile()) ? "есть" : "нет — создастся при setup"}`);
}

const [, , cmd, ...rest] = process.argv;
const cmds = {
  update: cmdUpdate,
  backup: cmdBackup,
  restore: cmdRestore,
  userbot: cmdUserbot,
  config: cmdConfig,
  login: cmdLogin,
  doctor: cmdDoctor,
  status: cmdStatus,
  restart: cmdRestart,
  recover: cmdRecover,
  reset: cmdReset,
  "workflow-smoke": cmdWorkflowSmoke,
  "workflow-postgres": cmdWorkflowPostgres,
  reminders: cmdReminders,
  usage: cmdUsage,
  start: cmdStart,
  stop: cmdStop,
  logs: cmdLogs,
  uninstall: cmdUninstall,
  version: cmdVersion,
  tree: showTree, // play the ANSI tree (wind animation)
  help: cmdHelp,
  "--help": cmdHelp,
  "-h": cmdHelp,
  // internal subcommand — install.sh delegates unit writing here (DRY)
  "_install-units": () => ok(`systemd units written: ${writeUnits().length}`),
};

const fn = cmds[cmd];
if (!fn) {
  if (cmd) bad(`Unknown command: ${cmd}`);
  cmdHelp();
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(fn(rest)).catch((e) => {
  bad(e?.message || String(e));
  process.exit(1);
});
