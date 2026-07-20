import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateIdentity, createReleaseReport, nextFixtureVersion, validateReleaseContract } from "./lib/release-contract.mjs";
import {
  collectProviderInventory,
  sanitizedProviderEvidence,
  validateVisionCanaryDescription,
} from "./lib/release-provider.mjs";
import { evaluateSoak } from "./lib/soak-contract.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const contract = validateReleaseContract(JSON.parse(read("scripts/release-contract.json")));
assert.equal(nextFixtureVersion("0.2.5"), "0.2.6");
assert.equal(nextFixtureVersion("0.3.0-rc.1"), "0.3.0-rc.2");
assert.equal(nextFixtureVersion("0.3.0-rc.2"), "0.3.0-rc.3");
assert.equal(nextFixtureVersion("0.3.0-rc.3"), "0.3.0-rc.4");
const capabilityManifest = { schemaVersion: 1, product: { name: "iva", version: "0.3.0-rc.1" } };
const commit = "a".repeat(40);
const identity = candidateIdentity({
  version: "0.3.0-rc.1", commit, tag: "v0.3.0-rc.1", capabilityManifest, contract,
});
assert.equal(identity.commit, commit);
assert.match(identity.capabilityManifestSha256, /^[0-9a-f]{64}$/);
assert.throws(
  () => candidateIdentity({ version: "0.3.0-rc.1", commit, tag: "v0.3.0", capabilityManifest, contract }),
  /does not match package version/,
);
assert.throws(
  () => candidateIdentity({ version: "0.3.0-rc.1", commit, tag: "v0.3.0-rc.1", dirty: true, capabilityManifest, contract }),
  /working tree is dirty/,
);

const incomplete = createReleaseReport({ identity, contract, results: [], generatedAt: "2026-07-17T00:00:00.000Z" });
assert.equal(incomplete.complete, false);
assert.ok(incomplete.scenarios.every(({ status }) => status === "missing"));
const complete = createReleaseReport({
  identity,
  contract,
  results: contract.requiredScenarios.map(({ id }) => ({ id, status: "pass", evidence: "fixture" })),
});
assert.equal(complete.complete, true);

const inventory = await collectProviderInventory({
  provider: "ollama",
  baseURL: "https://fixture.invalid/v1",
  apiKey: "synthetic",
  visionModel: "vision-fixture",
  fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "text-fixture" }, { id: "vision-fixture" }] }) }),
});
assert.deepEqual(inventory, { available: true, reason: null, modelCount: 2, visionModelPresent: true });
const providerEvidence = sanitizedProviderEvidence({
  textProvider: "codex", visionProvider: "ollama", textModel: "text-fixture", visionModel: "vision-fixture",
  inventory, description: "red pixel", commit,
});
assert.equal(providerEvidence.schemaVersion, 2);
assert.deepEqual(providerEvidence.text, { provider: "codex", model: "text-fixture" });
assert.equal(providerEvidence.vision.provider, "ollama");
assert.equal(providerEvidence.vision.status, "pass");
assert.equal(validateVisionCanaryDescription("Плакучая ива на чёрном фоне."), "Плакучая ива на чёрном фоне.");
assert.throws(() => validateVisionCanaryDescription("red pixel"), /tree and black background/);
assert.throws(() => sanitizedProviderEvidence({
  textProvider: "codex", visionProvider: "ollama", textModel: "text", visionModel: "missing",
  inventory: { ...inventory, visionModelPresent: false },
  description: "red pixel", commit,
}), /absent from authenticated inventory/);

const start = Date.parse("2026-07-01T00:00:00.000Z");
const samples = Array.from({ length: 7 * 24 + 1 }, (_, hour) => ({
  capturedAt: new Date(start + hour * 3_600_000).toISOString(), commit, status: "healthy", p0: 0, p1: 0,
}));
assert.equal(evaluateSoak({ samples, candidateCommit: commit, now: start + 7 * 86_400_000 }).complete, true);
assert.equal(evaluateSoak({ samples: samples.slice(0, -24), candidateCommit: commit, now: start + 6 * 86_400_000 }).complete, false);
assert.equal(evaluateSoak({ samples: samples.map((sample, index) => index === 3 ? { ...sample, p1: 1 } : sample), candidateCommit: commit }).complete, false);
assert.equal(evaluateSoak({ samples: samples.filter((_, index) => index !== 24), candidateCommit: commit }).complete, true);
assert.equal(evaluateSoak({ samples: samples.filter((_, index) => index < 24 || index > 28), candidateCommit: commit }).complete, false);

const workflow = read(".github/workflows/release-candidate.yml");
assert.match(workflow, /^name: Release candidate matrix$/m);
assert.match(workflow, /ref: \$\{\{ inputs\.candidate_tag \}\}/);
assert.match(workflow, /name: Build \(\$\{\{ matrix\.profile\.name \}\}\)/);
assert.match(workflow, /selector: "@workflow\/world-postgres"/);
assert.match(workflow, /run: npm run replica:postgres-update/);
assert.match(workflow, /run: node scripts\/release-report\.mjs > "\$RUNNER_TEMP\/release-matrix\.json"/);
assert.doesNotMatch(workflow, /secrets\.|TELEGRAM|ASSISTANT_VAULT/i);
assert.match(read("scripts/release-provider-canary.mjs"), /RELEASE_LIVE_CANARY !== "1"/);
assert.match(read("scripts/release-provider-canary.mjs"), /docs\/favicon\.png/);
assert.match(JSON.parse(read("package.json")).scripts["release:provider"], /--env-file-if-exists=\.env/);
assert.match(read("scripts/clean-install-smoke.mjs"), /update did not exercise an N-1 to N version transition/);

console.log("release contract checks passed: immutable identity, complete matrix, provider inventory, vision evidence and seven-day soak");
