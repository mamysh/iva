import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFileSync(join(root, path), "utf8");

const cli = read("bin/iva.mjs");
assert.match(cli, /const SERVICES = \["iva\.service", "iva-telegram-poll\.service"\]/);
assert.doesNotMatch(cli, /const SERVICES = \[[^\]]*userbot/);
assert.match(cli, /const TIMERS = \[\.\.\.MEMORY_TIMERS, "iva-reminders\.timer"\]/);
assert.match(cli, /EnvironmentFile=-\$\{WORKFLOW_ENV_PATH\}/);
assert.match(cli, /replaceAll\("__PYTHON_BIN__", VENV_PY\)/);
assert.match(cli, /scripts\/doctor\.mjs/);
assert.match(cli, /args\.includes\("--json"\)/);

const doctor = read("scripts/doctor.mjs");
assert.match(doctor, /CREATE TEMP TABLE iva_doctor_probe/);
assert.match(doctor, /workflow-health\.mjs", "status", "--json", "--no-sample"/);
assert.match(doctor, /IVA_DOCTOR_FIXED/);

const doctorContract = read("scripts/lib/doctor-contract.mjs");
assert.match(doctorContract, /schemaVersion: DOCTOR_SCHEMA_VERSION/);
assert.match(doctorContract, /blocksReplies/);
assert.match(doctorContract, /sanitizeSupportBundle/);

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
