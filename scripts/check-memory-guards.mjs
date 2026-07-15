import { strict as assert } from "node:assert";
import { CORE_CAP, coreRecoveryAction, gitPushFailureAlert } from "./lib/memory-guards.mjs";

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

console.log("memory guard checks passed");
