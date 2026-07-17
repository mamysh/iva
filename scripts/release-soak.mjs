#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { evaluateSoak } from "./lib/soak-contract.mjs";

const path = process.env.RELEASE_SOAK_SAMPLES;
if (!path) throw new Error("set RELEASE_SOAK_SAMPLES to a sanitized JSONL soak file");
const incidentPath = process.env.RELEASE_SOAK_INCIDENTS;
if (!incidentPath) throw new Error("set RELEASE_SOAK_INCIDENTS to a reviewed JSON incident array, including [] when empty");
const health = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const incidents = JSON.parse(readFileSync(incidentPath, "utf8"));
if (!Array.isArray(incidents)) throw new Error("release soak incidents must be a JSON array");
const candidateCommit = process.env.RELEASE_CANDIDATE_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const firstCandidate = health.findIndex((sample) => sample.release?.commit === candidateCommit);
if (firstCandidate < 0) throw new Error("no health samples exist for the candidate commit");
const candidateHealth = health.slice(firstCandidate);
const baselineRestarts = candidateHealth[0]?.services || {};
const samples = candidateHealth.map((sample, index) => ({
  ...sample,
  status: sample.release?.commit === candidateCommit &&
    Number(sample.workflow?.wedged || 0) === 0 &&
    Number(sample.services?.agentRestarts || 0) <= Number(baselineRestarts.agentRestarts || 0) &&
    Number(sample.services?.bridgeRestarts || 0) <= Number(baselineRestarts.bridgeRestarts || 0)
      ? "healthy" : "unhealthy",
  p0: index === candidateHealth.length - 1 ? incidents.filter(({ severity }) => severity === "P0").length : 0,
  p1: index === candidateHealth.length - 1 ? incidents.filter(({ severity }) => severity === "P1").length : 0,
}));
const result = evaluateSoak({ samples, candidateCommit });
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, candidateCommit, ...result }, null, 2)}\n`);
if (!result.complete) process.exitCode = 1;
