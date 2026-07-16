import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkflowProfile } from "./workflow-config.mjs";

export const WORKFLOW_BUILD_DESCRIPTOR = ".output/iva-workflow-profile.json";

function readSelectorFile(path) {
  const selected = {};
  if (!existsSync(path)) return selected;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*(WORKFLOW_TARGET_WORLD|IVA_WORKFLOW_WORLD)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    selected[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return selected;
}

export function resolveRuntimeWorkflowProfile(root, processEnv = process.env) {
  const workflowPath = join(root, "deploy/iva-workflow.environment");
  const appEnvPath = join(root, ".env");
  const workflowEnv = readSelectorFile(workflowPath);
  const appEnv = readSelectorFile(appEnvPath);
  const explicit = {};
  for (const key of ["WORKFLOW_TARGET_WORLD", "IVA_WORKFLOW_WORLD"]) {
    if (Object.hasOwn(processEnv, key)) explicit[key] = processEnv[key];
  }
  // Match systemd: the optional workflow file is loaded first and .env later.
  // A shell value is useful in clean CI, but cannot silently override installed runtime files.
  const env = { ...explicit, ...workflowEnv, ...appEnv };
  const selectorSource = Object.keys(appEnv).length
      ? ".env"
      : Object.keys(workflowEnv).length
        ? "deploy/iva-workflow.environment"
        : Object.keys(explicit).length
          ? "process environment"
          : "default";
  return { profile: resolveWorkflowProfile(env), selectorSource };
}

export function readWorkflowBuildDescriptor(root) {
  const path = join(root, WORKFLOW_BUILD_DESCRIPTOR);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
