#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { createCapabilityManifest } from "./capability-manifest.mjs";
import { candidateIdentity, createReleaseReport, parseScenarioResults } from "./lib/release-contract.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const contract = readJson("scripts/release-contract.json");
const packageJson = readJson("package.json");
const commit = git("rev-parse", "HEAD");
const dirty = Boolean(git("status", "--porcelain"));
const exactTags = git("tag", "--points-at", commit).split("\n").filter(Boolean);
const requestedTag = process.env.RELEASE_TAG || exactTags.find((tag) => tag === `v${packageJson.version}`);
const identity = candidateIdentity({
  version: packageJson.version,
  commit,
  tag: requestedTag,
  dirty,
  capabilityManifest: createCapabilityManifest(),
  contract,
});
const results = parseScenarioResults(process.env.RELEASE_SCENARIO_RESULTS);
const report = createReleaseReport({ identity, contract, results });
if (process.argv.includes("--require-complete") && !report.complete) {
  const missing = report.scenarios.filter(({ status }) => status !== "pass").map(({ id }) => id);
  throw new Error(`release matrix is incomplete: ${missing.join(", ")}`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
