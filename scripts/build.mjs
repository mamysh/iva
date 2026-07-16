#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkflowProfileDescriptor } from "./lib/workflow-config.mjs";
import { resolveRuntimeWorkflowProfile, WORKFLOW_BUILD_DESCRIPTOR } from "./lib/workflow-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { profile, selectorSource } = resolveRuntimeWorkflowProfile(ROOT);
const childEnv = { ...process.env, WORKFLOW_TARGET_WORLD: profile.backend === "postgres" ? profile.world : "local" };
delete childEnv.IVA_WORKFLOW_WORLD;

console.log(`[BUILD] Workflow profile: ${profile.label}`);
const result = spawnSync(process.execPath, [join(ROOT, "node_modules/eve/bin/eve.js"), "build"], {
  cwd: ROOT,
  env: childEnv,
  stdio: "inherit",
});
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const libs = join(ROOT, ".output/server/_libs");
const postgresBundlePresent =
  existsSync(libs) && readdirSync(libs, { recursive: true }).some((file) => String(file).includes("world-postgres"));
if (postgresBundlePresent !== (profile.backend === "postgres")) {
  console.error(`[BUILD] Workflow artifact does not match requested ${profile.backend} profile.`);
  process.exit(1);
}

const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
const packageVersion = lock.packages?.[`node_modules/${profile.buildTimePackage}`]?.version;
const descriptor = createWorkflowProfileDescriptor(profile, { packageVersion, selectorSource });
const target = join(ROOT, WORKFLOW_BUILD_DESCRIPTOR);
const temporary = `${target}.tmp`;
writeFileSync(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o644 });
renameSync(temporary, target);
console.log(`[BUILD] Workflow descriptor: ${profile.backend}`);
