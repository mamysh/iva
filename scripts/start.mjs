#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWorkflowProfileMatch } from "./lib/workflow-config.mjs";
import { readWorkflowBuildDescriptor, resolveRuntimeWorkflowProfile } from "./lib/workflow-runtime.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const { profile } = resolveRuntimeWorkflowProfile(ROOT);
  assertWorkflowProfileMatch(readWorkflowBuildDescriptor(ROOT), profile);
  console.log(`[START] Workflow profile: ${profile.label}`);
  if (process.argv.includes("--check-profile")) process.exit(0);

  const child = spawn(process.execPath, [join(ROOT, "node_modules/eve/bin/eve.js"), "start", ...process.argv.slice(2)], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} catch (error) {
  console.error(`[START] ${error.message}`);
  process.exit(1);
}
