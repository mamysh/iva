#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "iva-unit-write-"));
const fakeBin = join(sandbox, "bin");
const logPath = join(sandbox, "systemctl.log");
const unitDir = join(sandbox, ".config/systemd/user");

function installUnits() {
  const result = spawnSync(process.execPath, ["bin/iva.mjs", "_install-units"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: sandbox,
      IVA_NO_ANIM: "1",
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      SYSTEMCTL_LOG: logPath,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

try {
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "systemctl"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SYSTEMCTL_LOG\"\n", { mode: 0o755 });
  chmodSync(join(fakeBin, "systemctl"), 0o755);
  writeFileSync(logPath, "");

  installUnits();
  const servicePath = join(unitDir, "iva.service");
  const updateTimerPath = join(unitDir, "iva-update-check.timer");
  assert.equal(existsSync(servicePath), true);
  assert.equal(existsSync(updateTimerPath), true);
  assert.match(readFileSync(updateTimerPath, "utf8"), /OnCalendar=\*-\*-\* 10:00:00 [A-Za-z0-9_+\/-]+/);
  assert.doesNotMatch(readFileSync(updateTimerPath, "utf8"), /__ASSISTANT_TIMEZONE__/);
  assert.match(readFileSync(logPath, "utf8"), /--user daemon-reload/);
  const original = readFileSync(servicePath, "utf8");
  const originalMtime = statSync(servicePath, { bigint: true }).mtimeNs;

  writeFileSync(logPath, "");
  installUnits();
  assert.equal(readFileSync(logPath, "utf8"), "", "identical units must not trigger daemon-reload");
  assert.equal(statSync(servicePath, { bigint: true }).mtimeNs, originalMtime, "identical unit was rewritten");

  writeFileSync(servicePath, `${original}\n# stale local copy\n`);
  writeFileSync(logPath, "");
  installUnits();
  assert.equal(readFileSync(servicePath, "utf8"), original, "changed unit was not repaired");
  assert.match(readFileSync(logPath, "utf8"), /--user daemon-reload/);

  console.log("systemd unit write checks passed: unchanged units preserve runtime history");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
