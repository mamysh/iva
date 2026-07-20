#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import bashTool, { normalizeCwd } from "../agent/tools/bash.ts";

const fixture = mkdtempSync(join(tmpdir(), "iva-bash-cwd-"));
const actualFixture = realpathSync(fixture);
const file = join(fixture, "not-a-directory");
writeFileSync(file, "fixture", "utf8");

try {
  assert.deepEqual(normalizeCwd(), {});
  assert.deepEqual(normalizeCwd("  "), {});
  assert.deepEqual(normalizeCwd("~"), { cwd: homedir() });
  assert.deepEqual(normalizeCwd(fixture), { cwd: actualFixture });

  const homeChild = join(homedir(), "iva-cwd-path-that-must-not-exist");
  const missingHomeChild = normalizeCwd("~/iva-cwd-path-that-must-not-exist");
  assert.equal(missingHomeChild.cwd, undefined);
  assert.match(missingHomeChild.error || "", /HOME=/);
  assert.match(missingHomeChild.error || "", new RegExp(homeChild.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const missing = normalizeCwd(join(fixture, "missing"));
  assert.equal(missing.cwd, undefined);
  assert.match(missing.error || "", /не существует/);

  const notDirectory = normalizeCwd(file);
  assert.equal(notDirectory.cwd, undefined);
  assert.match(notDirectory.error || "", /не является/);

  const rejected = await bashTool.execute({ command: "pwd", cwd: join(fixture, "missing") }, {});
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /Повтори без cwd/);

  const executed = await bashTool.execute({ command: "pwd", cwd: fixture }, {});
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.cwd, actualFixture);
  assert.equal(executed.stdout.trim(), actualFixture);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log("bash cwd checks passed: normalization, rejection before exec and actual cwd reporting");
