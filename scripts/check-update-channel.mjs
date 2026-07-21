#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PRODUCTION_UPDATE_CHANNEL,
  readUpdateChannelState,
  resolveUpdateChannel,
  updateChannelStatePath,
  writeUpdateChannelState,
} from "./lib/update-channel.mjs";

function fakeGit({ branch = "main", tracking = "origin/main", detached = false, noTracking = false } = {}) {
  const calls = [];
  const runGit = (args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    if (key === "rev-parse --abbrev-ref HEAD") return { code: 0, out: detached ? "HEAD" : branch };
    if (key === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
      return noTracking ? { code: 1, out: "", err: "no upstream" } : { code: 0, out: tracking };
    }
    return { code: 1, out: "", err: `unexpected git call: ${key}` };
  };
  return { calls, runGit };
}

const legacyDir = mkdtempSync(join(tmpdir(), "iva-update-channel-legacy-"));
const legacy = fakeGit();
const migrated = resolveUpdateChannel({ dataDir: legacyDir, runGit: legacy.runGit });
assert.deepEqual(migrated.channel, PRODUCTION_UPDATE_CHANNEL);
assert.equal(migrated.currentBranch, "main");
assert.equal(migrated.migrated, true);
assert.deepEqual(JSON.parse(readFileSync(updateChannelStatePath(legacyDir), "utf8")), {
  schemaVersion: 1,
  remote: "origin",
  branch: "main",
});
assert.equal(statSync(updateChannelStatePath(legacyDir)).mode & 0o777, 0o600);

// A temporary checkout cannot replace the already pinned deployment channel.
const integration = fakeGit({ branch: "codex/integration", tracking: "origin/integration" });
const pinned = resolveUpdateChannel({ dataDir: legacyDir, runGit: integration.runGit });
assert.deepEqual(pinned.channel, PRODUCTION_UPDATE_CHANNEL);
assert.equal(pinned.currentBranch, "codex/integration");
assert.equal(pinned.migrated, false);
assert.equal(integration.calls.includes("rev-parse --abbrev-ref --symbolic-full-name @{upstream}"), false);
assert.throws(
  () => resolveUpdateChannel({ dataDir: legacyDir, runGit: integration.runGit, requireCheckout: true }),
  /current branch codex\/integration does not match origin\/main/,
);

const upstreamDir = mkdtempSync(join(tmpdir(), "iva-update-channel-upstream-"));
assert.throws(
  () => resolveUpdateChannel({ dataDir: upstreamDir, runGit: fakeGit({ tracking: "upstream/main" }).runGit }),
  /upstream\/main is not allowed/,
);

const otherBranchDir = mkdtempSync(join(tmpdir(), "iva-update-channel-branch-"));
assert.throws(
  () => resolveUpdateChannel({ dataDir: otherBranchDir, runGit: fakeGit({ branch: "feature", tracking: "origin/feature" }).runGit }),
  /origin\/feature is not allowed/,
);

const missingTrackingDir = mkdtempSync(join(tmpdir(), "iva-update-channel-no-tracking-"));
assert.throws(
  () => resolveUpdateChannel({ dataDir: missingTrackingDir, runGit: fakeGit({ noTracking: true }).runGit }),
  /has no tracking branch/,
);

const invalidDir = mkdtempSync(join(tmpdir(), "iva-update-channel-invalid-"));
writeFileSync(updateChannelStatePath(invalidDir), '{"schemaVersion":1,"remote":"upstream","branch":"main"}\n');
assert.throws(() => readUpdateChannelState(invalidDir), /only origin\/main is allowed/);

const detachedDir = mkdtempSync(join(tmpdir(), "iva-update-channel-detached-"));
writeUpdateChannelState(detachedDir);
assert.throws(
  () => resolveUpdateChannel({ dataDir: detachedDir, runGit: fakeGit({ detached: true }).runGit }),
  /detached HEAD/,
);

chmodSync(updateChannelStatePath(detachedDir), 0o644);
readUpdateChannelState(detachedDir);
assert.equal(statSync(updateChannelStatePath(detachedDir)).mode & 0o777, 0o600);

console.log("update channel checks passed");
