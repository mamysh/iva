import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const packageJson = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/verify.yml");
const baselineWorkflow = read(".github/workflows/resource-baseline.yml");
const testing = read("docs/testing.md");

assert.equal(packageJson.scripts["verify:pr"], "npm test && npm run typecheck && npm run build");
assert.match(packageJson.scripts.test, /node scripts\/check-core-canaries\.mjs/);
assert.match(packageJson.scripts.test, /node scripts\/check-capability-manifest\.mjs/);
assert.match(packageJson.scripts.test, /node scripts\/check-doctor-contract\.mjs/);
assert.match(packageJson.scripts.test, /node scripts\/check-update-transaction\.mjs/);

assert.match(workflow, /^permissions:\n  contents: read$/m);
assert.match(workflow, /uses: actions\/checkout@v6/);
assert.match(workflow, /uses: actions\/setup-node@v6/);
assert.match(workflow, /node-version: 24/);
assert.match(workflow, /run: npm ci/);
assert.match(workflow, /run: npm run verify:pr/);
assert.match(workflow, /name: Build \(\$\{\{ matrix\.profile\.name \}\}\)/);
assert.match(workflow, /selector: "@workflow\/world-postgres"/);
assert.match(workflow, /node scripts\/start\.mjs --check-profile/);
assert.match(workflow, /image: postgres:17/);
assert.match(workflow, /run: npm run replica:postgres/);
assert.match(workflow, /name: PostgreSQL peer profile/);
assert.match(workflow, /node scripts\/postgres-profile\.mjs prepare && node scripts\/postgres-profile\.mjs prepare/);
assert.match(workflow, /run: npm run replica:local/);
assert.match(workflow, /run: npm run replica:install/);
assert.doesNotMatch(workflow, /secrets\.|\.env|TELEGRAM|ASSISTANT_VAULT/i);

assert.match(baselineWorkflow, /^  workflow_dispatch:$/m);
assert.match(baselineWorkflow, /node-version: 24/);
assert.match(
  baselineWorkflow,
  /npm run baseline:resources -- --json > "\$RUNNER_TEMP\/resource-baseline\.json"/,
);
assert.match(baselineWorkflow, /path: \$\{\{ runner\.temp \}\}\/resource-baseline\.json/);
assert.match(baselineWorkflow, /uses: actions\/upload-artifact@v7/);
assert.doesNotMatch(baselineWorkflow, /secrets\.|\.env|TELEGRAM|ASSISTANT_VAULT/i);

assert.match(testing, /source of truth for choosing and executing Iva tests/i);
assert.match(testing, /npm run verify:pr/);
assert.match(testing, /disposable replica/i);
assert.match(testing, /npm run replica:local/);
assert.match(testing, /does not use the production installation as its test environment/i);

console.log("test policy checks passed");
