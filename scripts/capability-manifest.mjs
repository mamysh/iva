#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const readJson = (path) => JSON.parse(read(path));
const repoPath = (path) => relative(ROOT, path).replaceAll("\\", "/");
const byName = (a, b) => a.localeCompare(b, "en");

function conventionalSourceNames(directory, extension) {
  const pattern = new RegExp(`^([a-z0-9][a-z0-9_-]*)\\.${extension}$`);
  return readdirSync(join(ROOT, directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => entry.name.match(pattern)[1])
    .sort(byName);
}

function skillNames() {
  const directory = join(ROOT, "agent/skills");
  const names = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-z0-9][a-z0-9-]*\.md$/.test(entry.name)) {
      names.push(entry.name.slice(0, -3));
    } else if (entry.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(entry.name)) {
      if (existsSync(join(directory, entry.name, "SKILL.md"))) names.push(entry.name);
    }
  }
  return names.sort(byName);
}

function subagentNames() {
  const directory = join(ROOT, "agent/subagents");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "agent.ts")))
    .map((entry) => entry.name)
    .sort(byName);
}

function providerRoute() {
  const source = read("agent/provider.ts");
  const defaultProvider = source.match(/process\.env\.MODEL_PROVIDER \?\? "([^"]+)"/)?.[1];
  const providerBlock = source.match(/const PROVIDERS = \{([\s\S]*?)\n\} as const;/)?.[1] ?? "";
  const providers = [...providerBlock.matchAll(/^  ([a-z0-9-]+): \{$/gm)].map((match) => match[1]).sort(byName);
  if (!defaultProvider || providers.length === 0) throw new Error("Cannot derive provider route from agent/provider.ts");
  return {
    selector: "MODEL_PROVIDER",
    default: defaultProvider,
    providers,
    textModelSource: "agent/agent.ts",
    visionModelSource: "agent/vision.ts",
    configurationSource: "agent/provider.ts",
  };
}

function systemdCapabilities() {
  const deploy = join(ROOT, "deploy");
  const templates = readdirSync(deploy, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^iva-[a-z0-9-]+\.(?:service|timer)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort(byName);
  const timerTemplates = templates.filter((name) => name.endsWith(".timer"));
  const serviceTemplates = templates.filter((name) => name.endsWith(".service"));
  const oneshotServices = serviceTemplates
    .filter((name) => read(repoPath(join(deploy, name))).includes("Type=oneshot"))
    .sort(byName);
  const cli = read("bin/iva.mjs");
  const coreServices = JSON.parse(cli.match(/const SERVICES = (\[[^;]+\]);/)?.[1] ?? "null");
  if (!Array.isArray(coreServices)) throw new Error("Cannot derive managed services from bin/iva.mjs");
  return {
    managedServices: coreServices.sort(byName),
    managedTimers: timerTemplates,
    timerTriggeredServices: oneshotServices,
    optionalServices: serviceTemplates
      .filter((name) => !coreServices.includes(name) && !oneshotServices.includes(name))
      .sort(byName),
    templates,
  };
}

function runtimeVersions(packageJson, lock) {
  const workflowPackages = Object.entries(lock.packages)
    .filter(([path, value]) => /^node_modules\/@workflow\/[^/]+$/.test(path) && value?.version)
    .map(([path, value]) => ({ name: path.slice("node_modules/".length), version: value.version }))
    .sort((a, b) => byName(a.name, b.name));
  return {
    node: packageJson.engines.node,
    eve: lock.packages["node_modules/eve"].version,
    workflow: workflowPackages,
  };
}

export function createCapabilityManifest() {
  const packageJson = readJson("package.json");
  const lock = readJson("package-lock.json");
  return {
    schemaVersion: 1,
    product: { name: packageJson.name, version: packageJson.version },
    agent: {
      source: "agent/agent.ts",
      providerRoute: providerRoute(),
      capabilities: {
        tools: conventionalSourceNames("agent/tools", "ts"),
        skills: skillNames(),
        hooks: conventionalSourceNames("agent/hooks", "ts"),
        channels: conventionalSourceNames("agent/channels", "ts"),
        connections: conventionalSourceNames("agent/connections", "ts"),
        subagents: subagentNames(),
      },
    },
    systemd: systemdCapabilities(),
    storage: {
      contractVersion: 1,
      selector: ["WORKFLOW_TARGET_WORLD"],
      defaultProfile: "local",
      profiles: [
        { name: "local", world: "@workflow/world-local", bundled: true },
        { name: "postgres", world: "@workflow/world-postgres", bundled: false, optIn: true },
      ],
      configurationSource: "scripts/lib/workflow-config.mjs",
      buildDescriptor: ".output/iva-workflow-profile.json",
      postgresEnableCommand: "iva workflow-postgres enable",
      postgresIntegrationGate: "npm run replica:postgres",
      lifecycle: {
        updateCommand: "iva update",
        updateTransactionSource: "scripts/update-runtime.mjs",
        updateMigrationManifest: "scripts/update-manifest.json",
        doctorCommand: "iva doctor",
        doctorJsonCommand: "iva doctor --json",
        doctorSchemaVersion: 1,
        doctorSource: "scripts/doctor.mjs",
        statusCommand: "iva status",
        restartCommand: "iva restart",
        recoverCommand: "iva recover",
        resetCommand: "iva reset",
        diagnosticsSource: "scripts/workflow-health.mjs",
        purgeCommand: null,
      },
    },
    runtime: runtimeVersions(packageJson, lock),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === join(ROOT, relative(ROOT, process.argv[1]))) {
  process.stdout.write(`${JSON.stringify(createCapabilityManifest(), null, 2)}\n`);
}
