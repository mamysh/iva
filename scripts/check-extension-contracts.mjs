import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_EXTENSION_TYPES, assertNoUnsafeAgentBackgroundSources, discoverExtensionSurface,
  evaluateOptionalExtensionActivation, validateExtensionContractRegistry, validateManagedBackgroundTemplates,
} from "./lib/extension-contracts.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const registry = JSON.parse(readFileSync(new URL("./extension-contracts.json", import.meta.url), "utf8"));
validateExtensionContractRegistry(registry, { root: ROOT });
assert.deepEqual(registry.types.map(({ id }) => id), REQUIRED_EXTENSION_TYPES);
assertNoUnsafeAgentBackgroundSources(ROOT);
validateManagedBackgroundTemplates(ROOT);
for (const path of [
  "examples/extensions/provider.ts.txt", "examples/extensions/tool.ts.txt", "examples/extensions/skill.md.txt",
  "examples/extensions/channel.ts.txt", "examples/extensions/connection.ts.txt", "examples/extensions/hook.ts.txt",
  "examples/extensions/subagent/agent.ts.txt", "examples/extensions/subagent/instructions.md.txt",
  "examples/extensions/background-job.mjs.txt", "examples/extensions/background-job.service.txt",
  "examples/extensions/background-job.timer.txt", "examples/extensions/memory-processor.ts.txt",
]) assert.ok(readFileSync(join(ROOT, path), "utf8").trim(), `empty extension example: ${path}`);

const connection = structuredClone(registry.types.find(({ id }) => id === "channel-connection"));
connection.optionalDependencies = ["example-mcp-runtime"];
const missing = evaluateOptionalExtensionActivation(connection, { environment: {} });
assert.equal(missing.active, false);
assert.deepEqual(missing.missingConfig, ["EXAMPLE_MCP_URL", "EXAMPLE_MCP_TOKEN"]);
assert.deepEqual(missing.missingDependencies, ["example-mcp-runtime"]);
const configuredWithoutDependency = evaluateOptionalExtensionActivation(connection, {
  environment: { EXAMPLE_MCP_URL: "https://fixture.invalid/mcp", EXAMPLE_MCP_TOKEN: "fixture-token" },
});
assert.equal(configuredWithoutDependency.active, false, "optional extension activated before dependency check");
assert.deepEqual(configuredWithoutDependency.missingConfig, []);
assert.deepEqual(configuredWithoutDependency.missingDependencies, ["example-mcp-runtime"]);
assert.equal(evaluateOptionalExtensionActivation(connection, {
  environment: { EXAMPLE_MCP_URL: "https://fixture.invalid/mcp", EXAMPLE_MCP_TOKEN: "fixture-token" },
  availableDependencies: new Set(["example-mcp-runtime"]),
}).active, true);

const unsafeRegistry = structuredClone(registry);
unsafeRegistry.types.find(({ id }) => id === "background-job-timer").executionPolicy = "detached-shell";
assert.throws(() => validateExtensionContractRegistry(unsafeRegistry, { root: ROOT }), /detached shell execution is forbidden/);
const unownedRegistry = structuredClone(registry);
delete unownedRegistry.types.find(({ id }) => id === "background-job-timer").backgroundOwnership.health;
assert.throws(() => validateExtensionContractRegistry(unownedRegistry, { root: ROOT }), /missing background ownership health/);

const sandbox = mkdtempSync(join(tmpdir(), "iva-extension-contract-"));
try {
  for (const directory of ["agent/tools", "agent/hooks", "agent/channels", "agent/connections", "agent/subagents", "agent/skills"]) {
    mkdirSync(join(sandbox, directory), { recursive: true });
  }
  writeFileSync(join(sandbox, "agent/tools/core.ts"), "export default {};\n");
  writeFileSync(join(sandbox, "agent/connections/optional.ts"), "export default {};\n");
  const before = discoverExtensionSurface(sandbox);
  assert.deepEqual(before.tools, ["core.ts"]);
  assert.deepEqual(before.connections, ["optional.ts"]);
  rmSync(join(sandbox, "agent/connections/optional.ts"));
  const after = discoverExtensionSurface(sandbox);
  assert.deepEqual(after.tools, before.tools, "removing an optional extension changed the core surface");
  assert.deepEqual(after.connections, [], "removed optional extension remains discoverable");

  writeFileSync(join(sandbox, "agent/tools/unsafe.ts"), "spawn('job', [], { detached: true });\n");
  assert.throws(() => assertNoUnsafeAgentBackgroundSources(sandbox), /background execution is forbidden/);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

const instructions = readFileSync(join(ROOT, "agent/instructions.md"), "utf8");
assert.match(instructions, /ЗАПРЕЩЕНО запускать фоновые\/отвязанные процессы через `bash`/);
assert.match(instructions, /nohup.*setsid.*disown/s);
const cli = readFileSync(join(ROOT, "bin/iva.mjs"), "utf8");
const userbotSetupStart = cli.indexOf('if (sub === "setup")');
const userbotOffStart = cli.indexOf('if (sub === "off")', userbotSetupStart);
assert.ok(userbotSetupStart >= 0 && userbotOffStart > userbotSetupStart, "userbot setup block is missing");
const userbotSetupBlock = cli.slice(userbotSetupStart, userbotOffStart);
const userbotDependencyCheck = userbotSetupBlock.indexOf("ensureUserbotVenv();");
const userbotServiceEnable = userbotSetupBlock.indexOf('sc("enable", SVC_USERBOT)');
assert.ok(
  userbotDependencyCheck >= 0 && userbotServiceEnable >= 0 && userbotDependencyCheck < userbotServiceEnable,
  "optional userbot dependency is not checked before activation",
);
const serialized = JSON.stringify(registry);
assert.doesNotMatch(serialized, /(?:\/Users\/|\/home\/|\/root\/|postgresql:\/\/|BEGIN .* PRIVATE KEY)/);
console.log("extension contract checks passed: config/dependency fail-closed, managed background ownership, inert removal and capability-safe core");
