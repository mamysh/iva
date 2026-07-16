export const UPDATE_MANIFEST_SCHEMA_VERSION = 1;

function assertManifest(manifest, label) {
  if (!manifest || manifest.schemaVersion !== UPDATE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`${label} update manifest schema is unsupported`);
  }
  if (!Number.isInteger(manifest.migrationVersion) || manifest.migrationVersion < 0) {
    throw new Error(`${label} migrationVersion must be a non-negative integer`);
  }
  if (!Array.isArray(manifest.migrations)) throw new Error(`${label} migrations must be an array`);
}

export function createMigrationPlan(currentManifest, targetManifest, profile) {
  assertManifest(currentManifest, "current");
  assertManifest(targetManifest, "target");
  const currentVersion = currentManifest.migrationVersion;
  const targetVersion = targetManifest.migrationVersion;
  if (targetVersion < currentVersion) throw new Error("migration downgrade is not supported");
  if (targetVersion > currentVersion + 1) {
    throw new Error(`sequential update required: migration ${currentVersion} -> ${targetVersion} skips N-1`);
  }
  const migrations = targetManifest.migrations
    .filter((item) => item.version > currentVersion && item.version <= targetVersion)
    .filter((item) => item.profiles?.includes(profile));
  for (const migration of migrations) {
    if (!migration.id || !Number.isInteger(migration.version)) throw new Error("migration id/version is invalid");
    if (migration.command !== null && (!Array.isArray(migration.command) || migration.command.length < 2)) {
      throw new Error(`migration ${migration.id} command must be null or [program, ...args]`);
    }
    if (!['none', 'workflow'].includes(migration.backup)) throw new Error(`migration ${migration.id} backup contract is invalid`);
    if (!['forward-compatible', 'restore'].includes(migration.failureStrategy)) {
      throw new Error(`migration ${migration.id} failure strategy is invalid`);
    }
    if (migration.backup === 'workflow' && migration.failureStrategy === 'restore') continue;
    if (migration.command && migration.backup !== 'workflow') {
      throw new Error(`migration ${migration.id} must require a verified workflow backup`);
    }
  }
  return {
    currentVersion,
    targetVersion,
    migrations,
    requiresBackup: migrations.some((item) => item.backup === "workflow"),
  };
}

export function createUpdatePreflight(input) {
  return {
    schemaVersion: 1,
    currentCommit: input.currentCommit,
    targetCommit: input.targetCommit,
    currentVersion: input.currentVersion,
    targetVersion: input.targetVersion,
    profile: input.profile,
    migrations: input.migrationPlan.migrations.map(({ id, version, backup, failureStrategy }) => ({ id, version, backup, failureStrategy })),
    freeBytes: input.freeBytes,
    requiredBytes: input.requiredBytes,
    backupReady: input.backupReady,
    ready: input.freeBytes >= input.requiredBytes && (!input.migrationPlan.requiresBackup || input.backupReady),
  };
}

export async function runUpdateTransaction({ preflight, migrationPlan, actions }) {
  const events = [];
  const mark = (event) => events.push(event);
  let activated = false;
  let backup;
  try {
    if (!preflight.ready) throw new Error("update preflight blocked activation");
    mark("prepare");
    await actions.prepareTarget();
    if (migrationPlan.requiresBackup) {
      mark("backup");
      backup = await actions.createBackup();
      if (!backup?.verified) throw new Error("workflow backup could not be verified");
    }
    for (const migration of migrationPlan.migrations) {
      if (!migration.command) continue;
      mark(`migration:${migration.id}`);
      try {
        await actions.applyMigration(migration);
      } catch (error) {
        if (migration.failureStrategy === "restore") {
          mark("restore");
          await actions.restoreBackup(backup);
        }
        throw error;
      }
    }
    mark("activate");
    await actions.activate();
    activated = true;
    mark("restart");
    await actions.restart();
    mark("readiness");
    if (!(await actions.readiness())) throw new Error("target readiness failed");
    mark("commit");
    await actions.commit?.();
    return { outcome: "updated", events };
  } catch (error) {
    if (activated) {
      mark("rollback");
      await actions.rollbackActivation();
      mark("restart-previous");
      await actions.restartPrevious();
      if (!(await actions.previousReadiness())) throw new Error(`rollback failed after: ${error.message}`);
    }
    return { outcome: "rolled_back", reason: error.message, activated, events };
  } finally {
    await actions.cleanup?.();
  }
}
