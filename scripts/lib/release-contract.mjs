import { createHash } from "node:crypto";

export const RELEASE_CONTRACT_SCHEMA_VERSION = 1;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function nextFixtureVersion(currentVersion) {
  const version = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(currentVersion);
  if (!version) throw new Error(`unsupported fixture version: ${currentVersion}`);
  const [, major, minor, patch, rc] = version;
  return rc ? `${major}.${minor}.${patch}-rc.${Number(rc) + 1}` : `${major}.${minor}.${Number(patch) + 1}`;
}

export function validateReleaseContract(contract) {
  const errors = [];
  if (contract.schemaVersion !== RELEASE_CONTRACT_SCHEMA_VERSION) errors.push("unsupported release contract schema");
  for (const key of ["candidateTagPattern", "stableTagPattern"]) {
    try { new RegExp(contract[key]); } catch { errors.push(`invalid ${key}`); }
  }
  const scenarios = Array.isArray(contract.requiredScenarios) ? contract.requiredScenarios : [];
  if (!scenarios.length) errors.push("requiredScenarios must not be empty");
  const ids = new Set();
  for (const scenario of scenarios) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scenario.id || "")) errors.push(`invalid scenario id: ${scenario.id}`);
    if (ids.has(scenario.id)) errors.push(`duplicate scenario: ${scenario.id}`);
    ids.add(scenario.id);
    if (!["automated", "live", "soak", "acceptance"].includes(scenario.kind)) errors.push(`${scenario.id}: invalid kind`);
    if (!String(scenario.command || "").trim()) errors.push(`${scenario.id}: command is required`);
  }
  for (const required of [
    "verify-pr", "build-profile-matrix", "ubuntu-clean-local-install", "ubuntu-local-reinstall", "local-restart-resume",
    "postgres-clean-bootstrap", "postgres-restart-resume", "local-update-rollback", "postgres-update-rollback",
    "local-backup-restore", "postgres-backup-restore", "capability-manifest-comparison",
    "provider-inventory", "vision-live-canary", "production-like-soak-7d", "fresh-owner-documented-install",
  ]) if (!ids.has(required)) errors.push(`missing release scenario: ${required}`);
  if (contract.stableRequirements?.minimumSoakDays < 7) errors.push("stable soak cannot be shorter than 7 days");
  if (contract.stableRequirements?.backendDefaultObservationDays < 30) errors.push("backend default observation cannot be shorter than 30 days");
  if (errors.length) throw new Error(errors.join("\n"));
  return contract;
}

export function candidateIdentity({ version, commit, tag, dirty = false, capabilityManifest, contract }) {
  validateReleaseContract(contract);
  if (dirty) throw new Error("release candidate working tree is dirty");
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("release candidate commit must be a full SHA");
  if (tag !== `v${version}`) throw new Error(`release tag ${tag || "<missing>"} does not match package version v${version}`);
  const tagPattern = version.includes("-") ? contract.candidateTagPattern : contract.stableTagPattern;
  if (!new RegExp(tagPattern).test(tag)) throw new Error(`release tag does not satisfy ${tagPattern}`);
  return {
    version,
    tag,
    commit,
    capabilityManifestSha256: sha256(`${JSON.stringify(capabilityManifest)}\n`),
    releaseContractSha256: sha256(`${JSON.stringify(contract)}\n`),
  };
}

export function createReleaseReport({ identity, contract, results, generatedAt = new Date().toISOString() }) {
  const byId = new Map((results || []).map((result) => [result.id, result]));
  const scenarios = contract.requiredScenarios.map((scenario) => {
    const result = byId.get(scenario.id);
    return {
      id: scenario.id,
      kind: scenario.kind,
      status: result?.status || "missing",
      evidence: result?.evidence || null,
    };
  });
  const unknown = [...byId.keys()].filter((id) => !contract.requiredScenarios.some((scenario) => scenario.id === id));
  if (unknown.length) throw new Error(`unknown release scenario results: ${unknown.join(", ")}`);
  const complete = scenarios.every(({ status }) => status === "pass");
  return { schemaVersion: 1, generatedAt, candidate: identity, complete, scenarios };
}

export function parseScenarioResults(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("release results must be a JSON array");
  const ids = new Set();
  for (const result of parsed) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.id || "")) throw new Error("invalid release result id");
    if (ids.has(result.id)) throw new Error(`duplicate release result: ${result.id}`);
    ids.add(result.id);
    if (!["pass", "fail", "missing"].includes(result.status)) throw new Error(`${result.id}: invalid release result status`);
    if (result.evidence != null && !/^[A-Za-z0-9._:/@+-]+$/.test(result.evidence)) throw new Error(`${result.id}: unsafe evidence value`);
  }
  return parsed;
}
