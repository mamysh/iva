import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

const cli = read("bin/iva.mjs");
assert.match(cli, /const SERVICES = \["iva\.service", "iva-telegram-poll\.service"\]/);
assert.doesNotMatch(cli, /const SERVICES = \[[^\]]*userbot/);
assert.match(cli, /const TIMERS = \[\.\.\.MEMORY_TIMERS, "iva-reminders\.timer", "iva-observe\.timer"\]/);
assert.match(cli, /if \(scQ\("is-enabled", timer\)\.out !== "enabled"\) sc\("enable", "--now", timer\)/);
assert.match(cli, /EnvironmentFile=-\$\{WORKFLOW_ENV_PATH\}/);
assert.match(cli, /replaceAll\("__PYTHON_BIN__", VENV_PY\)/);
assert.match(cli, /scripts\/doctor\.mjs/);
assert.match(cli, /args\.includes\("--json"\)/);

const doctor = read("scripts/doctor.mjs");
assert.match(doctor, /CREATE TEMP TABLE iva_doctor_probe/);
assert.match(doctor, /workflow-health\.mjs", "status", "--json", "--no-sample"/);
assert.match(doctor, /IVA_DOCTOR_FIXED/);
assert.match(doctor, /backup-state\.json/);
assert.match(doctor, /metadataSha256/);

const doctorContract = read("scripts/lib/doctor-contract.mjs");
assert.match(doctorContract, /schemaVersion: DOCTOR_SCHEMA_VERSION/);
assert.match(doctorContract, /blocksReplies/);
assert.match(doctorContract, /sanitizeSupportBundle/);

const metrics = read("scripts/lib/health-metrics.mjs");
assert.match(metrics, /HEALTH_METRICS_MAX_SAMPLES = 24 \* 31/);
assert.match(metrics, /ALERT_BASELINE_MS = 7 \* 24/);
assert.match(metrics, /ALERT_COOLDOWN_MS = 24 \* 60/);
assert.match(read("deploy/iva-observe.service"), /Type=oneshot/);
assert.match(read("deploy/iva-observe.timer"), /OnCalendar=hourly/);

const updateRuntime = read("scripts/update-runtime.mjs");
const updateServices = read("scripts/lib/update-services.mjs");
assert.match(updateRuntime, /worktree", "add", "--detach"/);
assert.match(updateRuntime, /npm\(\["test"\]/);
assert.match(updateRuntime, /rollbackActivation/);
assert.match(updateRuntime, /doctor", "--json"/);
assert.match(updateRuntime, /profile\.backend === "local" \? "local" : profile\.world/);
assert.match(updateRuntime, /PATH: `\$\{NODE_BIN_DIR\}:\$\{process\.env\.PATH \|\| ""\}`/);
assert.match(updateRuntime, /stopManagedServices\(servicePlan\)/);
assert.match(updateServices, /\["iva-telegram-poll\.service", \.\.\.\(userbotActive \? \[UPDATE_USERBOT_SERVICE\] : \[\]\)\]/);
assert.match(updateServices, /\["iva\.service"\]/);
assert.doesNotMatch(updateRuntime, /@googleworkspace\/cli@latest/);

const backupRuntime = read("scripts/backup-runtime.mjs");
assert.match(backupRuntime, /stopWriters/);
assert.match(backupRuntime, /createPortableBackup/);
assert.match(backupRuntime, /verifyPortableBackup/);
assert.match(backupRuntime, /Services remain stopped|services remain stopped/i);
assert.match(backupRuntime, /iva-observe\.service/);
assert.match(backupRuntime, /iva-observe\.timer/);
const portableBackup = read("scripts/lib/portable-backup.mjs");
assert.match(portableBackup, /pg_dump/);
assert.match(portableBackup, /pg_restore/);
assert.match(portableBackup, /client < server/);
assert.match(portableBackup, /VAULT_EXCLUDES = new Set\(\["\.index", "\.graph"\]\)/);

const proxy = read("services/telegram-userbot/serve.py");
assert.match(proxy, /setdefault\("TELEGRAM_EXPOSED_TOOLS", "read-only"\)/);
assert.match(proxy, /host not in \{"127\.0\.0\.1", "::1", "localhost"\}/);

const requirements = read("services/telegram-userbot/requirements.txt");
assert.match(
  requirements,
  /telegram-mcp @ git\+https:\/\/github\.com\/chigwell\/telegram-mcp@f1a2d8e00a7f127bb7702655c58fdfcee7e73a5a/,
);
assert.doesNotMatch(requirements, /telegram-mcp @ .*@v3\.2\.0/);

const envExample = read(".env.example");
assert.match(envExample, /TELEGRAM_EXPOSED_TOOLS=read-only/);

console.log("integration invariant checks passed");
