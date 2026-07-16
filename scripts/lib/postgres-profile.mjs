export const POSTGRES_DATABASE = "iva_workflow";
export const POSTGRES_WORLD = "@workflow/world-postgres";

export const POSTGRES_SCHEMA_OBJECTS = [
  "workflow_drizzle.workflow_migrations",
  "workflow.workflow_runs",
  "workflow.workflow_steps",
  "workflow.workflow_events",
  "graphile_worker.jobs",
  "graphile_worker.migrations",
];

export function parseOsRelease(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

export function evaluatePostgresPreflight({ platform, osRelease, memoryMb, swapMb, diskFreeMb, serviceUser }) {
  const issues = [];
  const distro = parseOsRelease(osRelease);
  if (platform !== "linux") issues.push("PostgreSQL profile enable is supported only on Linux");
  if (!new Set(["ubuntu", "debian"]).has(distro.ID)) issues.push("supported OS is Ubuntu or Debian");
  const majorVersion = Number.parseInt(distro.VERSION_ID || "0", 10);
  if (distro.ID === "ubuntu" && majorVersion < 22) issues.push("supported Ubuntu version is 22.04 or newer");
  if (distro.ID === "debian" && majorVersion < 12) issues.push("supported Debian version is 12 or newer");
  if (!serviceUser || serviceUser === "root") issues.push("run this command as the non-root user that owns iva.service");
  if (Number(memoryMb || 0) + Number(swapMb || 0) < 1024) issues.push("at least 1 GiB combined RAM and swap is required");
  if (Number(diskFreeMb || 0) < 1024) issues.push("at least 1 GiB free disk is required");
  return { ok: issues.length === 0, issues, distro: distro.ID || "unknown", version: distro.VERSION_ID || "unknown" };
}

export function parsePostgresClusters(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [version, name, port, status, owner] = line.split(/\s+/);
      return { version, name, port: Number(port), status, owner };
    })
    .filter(({ version, name, port }) => Boolean(version && name && Number.isFinite(port)));
}

export function choosePostgresCluster(text) {
  const clusters = parsePostgresClusters(text);
  return clusters.find(({ status }) => status === "online") || clusters[0] || null;
}

export function quotePostgresIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function quotePostgresLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function selectPostgresSocketDirectory(value) {
  const candidates = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.startsWith("/"));
  if (!candidates.length) throw new Error("PostgreSQL does not expose an absolute Unix socket directory");
  return candidates[0];
}

export function postgresPeerUrl(socketDirectory, database = POSTGRES_DATABASE) {
  return `postgresql:///${database}?host=${encodeURIComponent(socketDirectory)}`;
}

export function postgresEnvironmentText(socketDirectory) {
  return [
    `WORKFLOW_TARGET_WORLD=${POSTGRES_WORLD}`,
    "WORKFLOW_QUEUE_NAMESPACE=eve",
    `WORKFLOW_POSTGRES_URL=${postgresPeerUrl(socketDirectory)}`,
    "WORKFLOW_POSTGRES_JOB_PREFIX=iva_",
    "WORKFLOW_POSTGRES_WORKER_CONCURRENCY=8",
    "WORKFLOW_POSTGRES_MAX_POOL_SIZE=10",
    "",
  ].join("\n");
}

export function postgresSchemaCheckSql(expectedWorkflowMigrations = 1) {
  const checks = POSTGRES_SCHEMA_OBJECTS.map((name) => `to_regclass(${quotePostgresLiteral(name)}) IS NOT NULL`);
  return `SELECT ${checks.join(", ")}, (SELECT count(*) FROM workflow_drizzle.workflow_migrations) = ${Number(expectedWorkflowMigrations)};`;
}

export function parsePostgresSchemaCheck(output) {
  const flags = String(output || "").trim().split("|");
  const names = [...POSTGRES_SCHEMA_OBJECTS, "all pinned workflow migrations"];
  const missing = names.filter((_, index) => flags[index] !== "t");
  return { ok: missing.length === 0, missing };
}
