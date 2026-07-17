import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const EXTENSION_CONTRACT_SCHEMA_VERSION = 1;
export const REQUIRED_EXTENSION_TYPES = Object.freeze([
  "provider", "tool", "skill", "channel-connection", "hook", "subagent", "background-job-timer", "memory-processor-indexer",
]);
const REQUIRED_FIELDS = [
  "sourcePattern", "example", "minimalInterface", "configSchema", "secrets", "optionalDependencies",
  "timeoutPolicy", "retryPolicy", "healthCheck", "sideEffectPolicy", "idempotencyPolicy", "fixture",
  "capabilityManifestSection", "executionPolicy", "backgroundOwnership",
];
const BACKGROUND_POLICIES = new Set(["managed-oneshot-only"]);
// Static source gate catches authored Node detachment. Shell spellings also appear in safety
// descriptions, so their runtime prohibition is asserted in agent/instructions.md instead.
const FORBIDDEN_BACKGROUND = /detached\s*:\s*true/;

export function validateExtensionContractRegistry(registry, { root } = {}) {
  const errors = [];
  if (registry.schemaVersion !== EXTENSION_CONTRACT_SCHEMA_VERSION) errors.push("unsupported extension contract schema");
  if (!Array.isArray(registry.types)) errors.push("extension contract types must be an array");
  const ids = new Set();
  for (const item of registry.types || []) {
    if (!REQUIRED_EXTENSION_TYPES.includes(item.id)) errors.push(`unknown extension type: ${item.id}`);
    if (ids.has(item.id)) errors.push(`duplicate extension type: ${item.id}`);
    ids.add(item.id);
    for (const field of REQUIRED_FIELDS) if (!(field in item)) errors.push(`${item.id}: missing ${field}`);
    const requiredConfig = Array.isArray(item.configSchema?.required) ? item.configSchema.required : [];
    const optionalConfig = Array.isArray(item.configSchema?.optional) ? item.configSchema.optional : [];
    if (!Array.isArray(item.configSchema?.required) || !Array.isArray(item.configSchema?.optional)) errors.push(`${item.id}: invalid configSchema`);
    for (const key of [...requiredConfig, ...optionalConfig, ...(item.secrets || [])]) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) errors.push(`${item.id}: invalid config key ${key}`);
    }
    for (const secret of item.secrets || []) if (!requiredConfig.includes(secret) && !optionalConfig.includes(secret)) errors.push(`${item.id}: undeclared secret ${secret}`);
    const background = BACKGROUND_POLICIES.has(item.executionPolicy);
    if (background) {
      for (const field of ["service", "timer", "logs", "health", "uninstall"]) if (!item.backgroundOwnership?.[field]) errors.push(`${item.id}: missing background ownership ${field}`);
    } else if (item.backgroundOwnership !== null) errors.push(`${item.id}: inline/runtime extension cannot own a background process`);
    if (item.executionPolicy === "detached-shell") errors.push(`${item.id}: detached shell execution is forbidden`);
    if (root && (!item.example.startsWith("examples/extensions/") || !existsSync(join(root, item.example)))) errors.push(`${item.id}: inert example is missing`);
  }
  for (const id of REQUIRED_EXTENSION_TYPES) if (!ids.has(id)) errors.push(`missing extension type: ${id}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return registry;
}

export function evaluateOptionalExtensionActivation(contract, {
  environment = {}, availableDependencies = new Set(), dependencyExists = (name) => availableDependencies.has(name),
} = {}) {
  const missingConfig = (contract.configSchema?.required || []).filter((key) => !String(environment[key] || "").trim());
  const missingDependencies = (contract.optionalDependencies || []).filter((name) => !dependencyExists(name));
  return { active: missingConfig.length === 0 && missingDependencies.length === 0, missingConfig, missingDependencies };
}

function sourceFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? sourceFiles(child) : entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) ? [child] : [];
  });
}

export function assertNoUnsafeAgentBackgroundSources(root) {
  const roots = ["tools", "hooks", "channels", "connections", "subagents"].map((name) => join(root, "agent", name));
  const bad = roots.flatMap(sourceFiles).filter((path) => FORBIDDEN_BACKGROUND.test(readFileSync(path, "utf8")));
  if (bad.length) throw new Error(`agent-authored background execution is forbidden: ${bad.map((path) => path.split("/").at(-1)).join(", ")}`);
  return true;
}

export function validateManagedBackgroundTemplates(root) {
  const deploy = join(root, "deploy");
  const services = readdirSync(deploy).filter((name) => /^iva-.*\.service$/.test(name));
  const errors = [];
  for (const service of services) {
    const source = readFileSync(join(deploy, service), "utf8");
    if (!/^Type=oneshot$/m.test(source)) continue;
    for (const pattern of [/^RuntimeMaxSec=\S+$/m, /^WorkingDirectory=\S+$/m, /^ExecStart=\S+/m]) {
      if (!pattern.test(source)) errors.push(`${service}: incomplete oneshot ownership (${pattern.source})`);
    }
    const timer = service.replace(/\.service$/, ".timer");
    if (!existsSync(join(deploy, timer))) errors.push(`${service}: matching timer is missing`);
    else if (!/^Persistent=true$/m.test(readFileSync(join(deploy, timer), "utf8"))) errors.push(`${timer}: Persistent=true is required`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  return true;
}

export function discoverExtensionSurface(root) {
  const names = (directory, pattern) => existsSync(join(root, directory))
    ? readdirSync(join(root, directory), { withFileTypes: true }).filter((entry) => pattern.test(entry.name)).map((entry) => entry.name).sort()
    : [];
  return {
    tools: names("agent/tools", /\.ts$/), hooks: names("agent/hooks", /\.ts$/),
    channels: names("agent/channels", /\.ts$/), connections: names("agent/connections", /\.ts$/),
    skills: names("agent/skills", /^(?!.*\.txt$).+/), subagents: names("agent/subagents", /^(?!\.).+/),
  };
}
