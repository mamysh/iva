#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "eve/client";
import { evaluateInstallReadiness, INSTALL_SERVICES } from "./lib/install-readiness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsonMode = process.argv.includes("--json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function command(commandName, args) {
  const result = spawnSync(commandName, args, { encoding: "utf8", timeout: 10_000 });
  return { ok: result.status === 0, output: (result.stdout || "").trim() };
}

function configured() {
  const provider = process.env.MODEL_PROVIDER || "ollama";
  const providerKeys = {
    ollama: ["OLLAMA_API_KEY", "OLLAMA_MODEL"],
    opencode: ["OPENCODE_API_KEY", "OPENCODE_MODEL"],
    openrouter: ["OPENROUTER_API_KEY", "OPENROUTER_MODEL"],
    codex: ["CODEX_MODEL"],
  };
  const required = [
    ...(providerKeys[provider] || providerKeys.ollama),
    "DEEPGRAM_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
  ];
  if (!required.every((key) => Boolean((process.env[key] || "").trim()))) return false;
  if (provider !== "codex") return true;
  const dataDir = process.env.ASSISTANT_DATA_DIR || "data";
  return existsSync(join(isAbsolute(dataDir) ? dataDir : join(ROOT, dataDir), "codex-auth.json"));
}

async function waitForHealth(host, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await Promise.race([
        new Client({ host }).health(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("health timeout")), 3_000)),
      ]);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

const isConfigured = configured();
const systemdAvailable = command("systemctl", ["--user", "show-environment"]).ok;
const serviceStarts = {};
for (const name of INSTALL_SERVICES) {
  const restartOutput = systemdAvailable
    ? command("systemctl", ["--user", "show", name, "--property=NRestarts", "--value"]).output
    : "0";
  serviceStarts[name] = Number.parseInt(restartOutput, 10) || 0;
}

const host = process.env.ASSISTANT_HOST || `http://127.0.0.1:${process.env.IVA_PORT || "8723"}`;
const healthOk = isConfigured && (await waitForHealth(host));
if (healthOk) await sleep(2_000);
const stableHealthOk = healthOk && (await waitForHealth(host, 5_000));
const services = {};
for (const name of INSTALL_SERVICES) {
  const active = systemdAvailable && command("systemctl", ["--user", "is-active", "--quiet", name]).ok;
  const restartOutput = systemdAvailable
    ? command("systemctl", ["--user", "show", name, "--property=NRestarts", "--value"]).output
    : "0";
  const journal = systemdAvailable
    ? command("journalctl", ["--user", "-u", name, "--since", "-2 minutes", "-n", "80", "--no-pager"]).output
    : "";
  services[name] = {
    active,
    restarts: Math.max(0, (Number.parseInt(restartOutput, 10) || 0) - serviceStarts[name]),
    terminalError: /uncaught|fatal|start request repeated too quickly|failed with result|exited with code/i.test(journal),
  };
}
const result = evaluateInstallReadiness({
  configured: isConfigured,
  buildPresent: existsSync(join(ROOT, ".output", "server", "index.mjs")),
  systemdAvailable,
  healthOk,
  stableHealthOk,
  services,
});

if (jsonMode) console.log(JSON.stringify(result, null, 2));
else if (result.ready) console.log("install readiness: ready (Eve healthy, services stable, Telegram bridge active)");
else {
  console.error(`install readiness: ${result.status}`);
  for (const issue of result.issues) console.error(`- ${issue}`);
  console.error(`resume: ${result.resume}`);
}

process.exit(result.ready ? 0 : result.status === "configuration_pending" ? 2 : 1);
