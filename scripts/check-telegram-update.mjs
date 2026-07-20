import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTROL_COMMANDS, checkDeploymentUpdate, packageVersion, parseUpdateAction } from "./lib/telegram-update.mjs";

assert(CONTROL_COMMANDS.includes("/reminders"));
assert(CONTROL_COMMANDS.includes("/update"));
assert(CONTROL_COMMANDS.includes("/model"));
assert(CONTROL_COMMANDS.includes("/think"));
assert.equal(parseUpdateAction("iva_update:do"), "do");
assert.equal(parseUpdateAction("iva_update:skip"), "skip");
assert.equal(parseUpdateAction("iva_update:delete_everything"), null);
assert.equal(packageVersion('{"version":"0.2.5"}'), "0.2.5");
assert.equal(packageVersion("not-json"), null);

const poll = readFileSync(new URL("./telegram-poll.mjs", import.meta.url), "utf8");
assert.match(poll, /cq\.data\.startsWith\("iva_model:"\)/);
assert.match(poll, /modelWizard\.open\(cmd === "\/think" \? "think" : "model"/);
assert.match(poll, /setMyCommands/);
const modelCallback = poll.indexOf('cq.data.startsWith("iva_model:")');
const modelHandle = poll.indexOf("modelWizard.handle", modelCallback);
const ownerGate = poll.indexOf("!ALLOWED.has(from)", modelCallback);
assert.ok(modelCallback >= 0 && ownerGate > modelCallback && modelHandle > ownerGate, "model callback must be owner-gated before wizard state");

function fakeGit({ local = "local", remote = "remote", behind = "0", ahead = "0", localVer = "0.2.5", remoteVer = "0.2.5", fail } = {}) {
  return async (...args) => {
    const key = args.join(" ");
    if (fail && key.startsWith(fail)) throw new Error(`git failed: ${key}`);
    if (key === "rev-parse --abbrev-ref HEAD") return "main";
    if (key === "fetch --prune origin main") return "";
    if (key === "rev-parse HEAD") return local;
    if (key === "rev-parse origin/main") return remote;
    if (key === "rev-list --count HEAD..origin/main") return behind;
    if (key === "rev-list --count origin/main..HEAD") return ahead;
    if (key === "show HEAD:package.json") return JSON.stringify({ version: localVer });
    if (key === "show origin/main:package.json") return JSON.stringify({ version: remoteVer });
    throw new Error(`unexpected git call: ${key}`);
  };
}

assert.equal((await checkDeploymentUpdate(fakeGit({ local: "same", remote: "same" }))).hasUpdate, false);
assert.equal((await checkDeploymentUpdate(fakeGit({ local: "ahead", remote: "old", behind: "0", ahead: "2" }))).rewritten, true);
assert.equal((await checkDeploymentUpdate(fakeGit({ local: "ahead", remote: "old", behind: "0", ahead: "2" }))).hasUpdate, true);
assert.equal((await checkDeploymentUpdate(fakeGit({ local: "old", remote: "new", behind: "2" }))).hasUpdate, true);
await assert.rejects(checkDeploymentUpdate(fakeGit({ fail: "fetch" })), /git failed/);
await assert.rejects(checkDeploymentUpdate(fakeGit({ behind: "" })), /invalid git behind count/);
await assert.rejects(checkDeploymentUpdate(fakeGit({ ahead: "" })), /invalid git ahead count/);

console.log("telegram update checks passed");
