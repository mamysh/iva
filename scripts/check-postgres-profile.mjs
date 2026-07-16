import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  POSTGRES_SCHEMA_OBJECTS,
  choosePostgresCluster,
  evaluatePostgresPreflight,
  parsePostgresClusters,
  parsePostgresSchemaCheck,
  postgresEnvironmentText,
  postgresPeerUrl,
  postgresSchemaCheckSql,
  quotePostgresIdentifier,
  quotePostgresLiteral,
  selectPostgresSocketDirectory,
} from "./lib/postgres-profile.mjs";

const ubuntu = "ID=ubuntu\nVERSION_ID=24.04\n";
const debian = "ID=debian\nVERSION_ID=13\n";
assert.equal(
  evaluatePostgresPreflight({
    platform: "linux",
    osRelease: ubuntu,
    memoryMb: 768,
    swapMb: 512,
    diskFreeMb: 2048,
    serviceUser: "iva-owner",
  }).ok,
  true,
);
assert.equal(
  evaluatePostgresPreflight({
    platform: "linux",
    osRelease: debian,
    memoryMb: 512,
    swapMb: 0,
    diskFreeMb: 500,
    serviceUser: "root",
  }).issues.length,
  3,
);
assert.equal(
  evaluatePostgresPreflight({
    platform: "darwin",
    osRelease: "ID=macos\n",
    memoryMb: 4096,
    swapMb: 0,
    diskFreeMb: 4096,
    serviceUser: "owner",
  }).ok,
  false,
);

const clusterOutput = [
  "15 legacy 5433 down postgres /var/lib/postgresql/15/legacy /var/log/postgresql/legacy.log",
  "17 main 5432 online postgres /var/lib/postgresql/17/main /var/log/postgresql/main.log",
].join("\n");
assert.equal(parsePostgresClusters(clusterOutput).length, 2);
assert.deepEqual(choosePostgresCluster(clusterOutput), {
  version: "17",
  name: "main",
  port: 5432,
  status: "online",
  owner: "postgres",
});
assert.equal(choosePostgresCluster(""), null);

assert.equal(quotePostgresIdentifier('iva-"owner'), '"iva-""owner"');
assert.equal(quotePostgresLiteral("owner's"), "'owner''s'");
assert.equal(selectPostgresSocketDirectory("/run/postgresql, /tmp"), "/run/postgresql");
assert.throws(() => selectPostgresSocketDirectory("@abstract"), /absolute Unix socket/);
assert.equal(postgresPeerUrl("/run/postgresql"), "postgresql:///iva_workflow?host=%2Frun%2Fpostgresql");
const environment = postgresEnvironmentText("/run/postgresql");
assert.match(environment, /^WORKFLOW_TARGET_WORLD=@workflow\/world-postgres$/m);
assert.doesNotMatch(environment, /password|username|iva-owner/i);
const schemaSql = postgresSchemaCheckSql();
for (const object of POSTGRES_SCHEMA_OBJECTS) assert.match(schemaSql, new RegExp(object.replace(".", "\\.")));
assert.match(postgresSchemaCheckSql(16), /count\(\*\).* = 16/);
assert.deepEqual(parsePostgresSchemaCheck("t|t|t|t|t|t|t\n"), { ok: true, missing: [] });
assert.deepEqual(parsePostgresSchemaCheck("t|t|f|t|f|t|t").missing, [
  "workflow.workflow_steps",
  "graphile_worker.jobs",
]);

const installer = readFileSync(new URL("./postgres-profile.mjs", import.meta.url), "utf8");
const cli = readFileSync(new URL("../bin/iva.mjs", import.meta.url), "utf8");
assert.match(installer, /node_modules\/@workflow\/world-postgres\/bin\/setup\.js/);
assert.match(installer, /SHOW config_file/);
assert.match(installer, /SHOW unix_socket_directories/);
assert.match(installer, /runCount === 0/);
assert.match(installer, /mode & 0o777\) !== 0o600/);
assert.doesNotMatch(installer, /\/etc\/postgresql\/\d+/);
assert.match(cli, /"workflow-postgres": cmdWorkflowPostgres/);
assert.match(cli, /PostgreSQL workflow unavailable/);

console.log("PostgreSQL profile checks passed");
