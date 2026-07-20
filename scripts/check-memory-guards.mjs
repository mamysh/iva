import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  CORE_CAP,
  MEMORY_DURABILITY_CASES,
  coreRecoveryAction,
  emotionalMemoryPolicy,
  gitPushFailureAlert,
} from "./lib/memory-guards.mjs";

assert.equal(coreRecoveryAction("valid", "x".repeat(CORE_CAP)), "accept");
assert.equal(coreRecoveryAction("valid", "x".repeat(CORE_CAP + 1)), "restore");
assert.equal(coreRecoveryAction("valid", ""), "restore");
assert.equal(coreRecoveryAction("x".repeat(CORE_CAP + 1), "x".repeat(CORE_CAP + 1)), "fail");

const large = gitPushFailureAlert("remote: error: GH001: Large files detected", "/vault");
assert.match(large, /oversized files/);
assert.match(large, /credentials are working/);
const auth = gitPushFailureAlert("fatal: Authentication failed", "/vault");
assert.match(auth, /authentication failed/);
const other = gitPushFailureAlert("fatal: the remote end hung up unexpectedly", "/vault");
assert.match(other, /non-authentication reason/);

const policy = emotionalMemoryPolicy();
assert.match(policy, /NEVER identity-level facts/);
assert.match(policy, /daily-summary/);
assert.match(policy, /archived note/);
assert.match(policy, /stable preference/);
assert.match(policy, /medical or historical fact/);

assert.deepEqual(
  MEMORY_DURABILITY_CASES.map(({ classification, destination, identity }) => ({ classification, destination, identity })),
  [
    { classification: "transient-emotion", destination: "daily-summary", identity: false },
    { classification: "durable-preference", destination: "CORE", identity: true },
    { classification: "explicit-contextual-fact", destination: "archived-note", identity: false },
  ],
);

const rollup = readFileSync(new URL("./memory/rollup.ts", import.meta.url), "utf8");
assert.match(rollup, /emotionalMemoryPolicy\(\)/, "daily rollup must apply the durability policy");
const memoryMap = readFileSync(new URL("../agent/instructions/10-map.md", import.meta.url), "utf8");
assert.match(memoryMap, /не являются identity-фактом/);
const schema = JSON.parse(
  readFileSync(new URL("../vault-template/.claude/skills/autograph/schema.json", import.meta.url), "utf8"),
);
assert.equal(schema.type_aliases.emotional_state, "note");

console.log("memory guard checks passed");
