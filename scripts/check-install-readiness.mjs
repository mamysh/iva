import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { evaluateInstallReadiness, INSTALL_SERVICES } from "./lib/install-readiness.mjs";

const healthyServices = Object.fromEntries(
  INSTALL_SERVICES.map((name) => [name, { active: true, restarts: 0, terminalError: false }]),
);
const healthy = {
  configured: true,
  buildPresent: true,
  systemdAvailable: true,
  healthOk: true,
  stableHealthOk: true,
  services: healthyServices,
};

assert.deepEqual(evaluateInstallReadiness(healthy), {
  status: "ready",
  ready: true,
  issues: [],
  resume: null,
});

const pending = evaluateInstallReadiness({ ...healthy, configured: false });
assert.equal(pending.status, "configuration_pending");
assert.equal(pending.ready, false);
assert.match(pending.resume, /npm run setup/);

for (const mutation of [
  { healthOk: false },
  { stableHealthOk: false },
  { services: { ...healthyServices, "iva.service": { active: false, restarts: 0, terminalError: false } } },
  { services: { ...healthyServices, "iva.service": { active: true, restarts: 3, terminalError: false } } },
  { services: { ...healthyServices, "iva-telegram-poll.service": { active: true, restarts: 0, terminalError: true } } },
]) {
  const result = evaluateInstallReadiness({ ...healthy, ...mutation });
  assert.equal(result.status, "readiness_failed");
  assert.equal(result.ready, false);
}

const install = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const setup = readFileSync(new URL("./setup.mjs", import.meta.url), "utf8");
const oauth = readFileSync(new URL("./lib/codex-oauth.mjs", import.meta.url), "utf8");
const stages = [...install.matchAll(/^\s*install_stage ([a-z]+)(?: .*)?$/gm)].map((match) => match[1]);
assert.deepEqual(stages, [
  "preflight",
  "packages",
  "runtime",
  "checkout",
  "dependencies",
  "setup",
  "build",
  "vault",
  "units",
  "readiness",
]);
assert.match(install, /scripts\/install-readiness\.mjs/);
assert.match(install, /install-state\.jsonl/);
assert.match(install, /chmod 600 "\$INSTALL_STATE_FILE"/);
assert.match(install, /chmod 600 \.env/);
assert.match(install, /chmod 600 deploy\/iva-workflow\.environment/);
assert.match(setup, /chmod\(ENV_PATH, 0o600\)/);
assert.match(oauth, /writeFileSync\(tmp, JSON\.stringify\(auth, null, 2\), \{ mode: 0o600 \}\)/);
assert.match(oauth, /chmodSync\(tmp, 0o600\)/);
assert.match(install, /install_stage build "npm run build && bash install\.sh"/);
assert.match(install, /step .*profile-aware Eve build/);
assert.match(install, /^npm run build$/m);
assert.doesNotMatch(install, /npm exec -- eve build/);
assert.match(install, /install_stage readiness "iva doctor && bash install\.sh"/);
assert.doesNotMatch(install, /record_install_state[^\n]*(TOKEN|KEY|SECRET|PASSWORD)/i);
assert.doesNotMatch(install, /api\.telegram\.org\/bot\$_bot\/sendMessage/);
assert.doesNotMatch(install, /Bot enabled and online|Бот включён и на связи/);
assert.match(install, /Runtime installed, configuration pending|Runtime installed; readiness not verified/);

console.log("install readiness checks passed");
