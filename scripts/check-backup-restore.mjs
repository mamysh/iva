import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createCapabilityManifest } from "./capability-manifest.mjs";
import { loadReminders } from "./lib/reminders-store.mjs";
import { auditPrivateState, createPortableBackup, hardenPrivateState, restorePortableBackup, verifyPortableBackup } from "./lib/portable-backup.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const sandbox = await mkdtemp(join(tmpdir(), "iva-backup-restore-"));
const source = join(sandbox, "source");
const target = join(sandbox, "clean-host");
const backup = join(sandbox, "portable-backup");

function privateFile(path, content) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function callTaskTool(dataDir, input) {
  const toolUrl = pathToFileURL(join(ROOT, "agent/tools/tasks.ts")).href;
  const program = [
    `const tool = (await import(${JSON.stringify(toolUrl)})).default;`,
    "const result = await tool.execute(JSON.parse(process.argv[1]));",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", program, JSON.stringify(input)], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ASSISTANT_DATA_DIR: dataDir },
  }));
}

function assertPrivate(path) {
  assert.equal(statSync(path).mode & 0o077, 0, `${path} is group/world accessible`);
}

try {
  mkdirSync(join(source, "deploy"), { recursive: true });
  privateFile(join(source, ".env"), "ASSISTANT_DATA_DIR=data\nASSISTANT_VAULT_DIR=vault\nWORKFLOW_TARGET_WORLD=local\n");
  privateFile(join(source, "data/tasks.json"), `${JSON.stringify([{ id: 1, text: "restored task", priority: "high", due: null, done: false, createdAt: "2026-01-01T00:00:00.000Z" }], null, 2)}\n`);
  privateFile(join(source, "data/reminders.json"), `${JSON.stringify([{ id: 1, text: "restored reminder", dueAt: "2030-01-01T00:00:00.000Z", timezone: "UTC", status: "pending", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }], null, 2)}\n`);
  privateFile(join(source, "data/usage.jsonl"), '{"ts":"2026-01-01T00:00:00.000Z","total":7}\n');
  privateFile(join(source, "data/codex-auth.json"), '{"refresh_token":"synthetic-secret"}\n');
  privateFile(join(source, "data/telegram-userbot.token"), "synthetic-userbot-token\n");
  privateFile(join(source, "data/telegram-userbot.session"), "synthetic-session\n");
  privateFile(join(source, "data/backups/obsolete.dump"), "must not recurse\n");
  privateFile(join(source, "data/health-metrics.jsonl"), '{"derived":true}\n');
  privateFile(join(source, "data/health-alert-state.json"), '{"derived":true}\n');
  privateFile(join(source, "data/workflow-health.json"), '{"derived":true}\n');
  privateFile(join(source, "data/update.lock/owner.json"), '{"derived":true}\n');
  privateFile(join(source, "data/update-jobs/synthetic.json"), '{"derived":true}\n');
  privateFile(join(source, "data/update-notification-state.json"), '{"schemaVersion":1,"lastCheckedCommit":"aaaaaaaa","lastNotifiedCommit":"aaaaaaaa"}\n');
  privateFile(join(source, "data/telegram-mcp/.git/config"), "[core]\n\trepositoryformatversion = 0\n");
  privateFile(join(source, "data/telegram-mcp/.gitignore"), ".venv/\n");
  privateFile(join(source, "data/telegram-mcp/.venv/lib/runtime.py"), "derived virtual environment\n");
  symlinkSync("lib", join(source, "data/telegram-mcp/.venv/lib64"), "dir");
  privateFile(join(source, "data/nested-order/a/child"), "nested inventory\n");
  privateFile(join(source, "data/nested-order/a-"), "adjacent inventory\n");
  privateFile(join(source, "vault/cards/canary-fact.md"), "---\nname: Restore fact\nstatus: active\nconfidence: HIGH\n---\nThe restore phrase is amber orchard 731.\n");
  privateFile(join(source, "vault/.index/embeddings.json"), '{"derived":true}\n');
  privateFile(join(source, "vault/.graph/links.json"), '{"derived":true}\n');
  privateFile(join(source, ".eve/.workflow-data/session-marker.json"), '{"session":"durable-local-session"}\n');
  privateFile(join(source, ".eve/builds/generated-artifact.json"), '{"derived":true}\n');

  chmodSync(join(source, "data/codex-auth.json"), 0o644);
  assert.equal(auditPrivateState({ root: source }).ok, false, "permission audit missed a world-readable OAuth artifact");
  assert.equal(hardenPrivateState({ root: source }).ok, true, "permission hardening did not repair private state");

  const beforeCapabilities = createCapabilityManifest();
  assert.throws(() => createPortableBackup({
    root: source,
    destination: join(source, "unsafe-backup"),
    writersStopped: true,
  }), /outside the Iva code repository/);
  const created = createPortableBackup({
    root: source,
    destination: backup,
    writersStopped: true,
    commit: "synthetic-commit",
    version: "0.0.0-fixture",
  });
  assert.equal(created.metadata.source.profile, "local");
  const verified = verifyPortableBackup(backup);
  assert.ok(verified.files.some((file) => file.path === "payload/data/tasks.json"));
  assert.ok(verified.files.some((file) => file.path === "payload/data/telegram-userbot.session"));
  assert.ok(verified.files.some((file) => file.path === "payload/data/telegram-mcp/.git/config"), "nested application data must remain portable");
  assert.ok(verified.files.every((file) => !file.path.includes("/.venv/")), "derived virtual environments entered the backup");
  assert.ok(verified.files.some((file) => file.path === "payload/workflow/local/session-marker.json"));
  assert.ok(verified.files.every((file) => !file.path.includes("generated-artifact")), "derived .eve data entered the backup");
  assert.ok(verified.files.every((file) => !file.path.includes("/backups/")));
  assert.ok(verified.files.every((file) => !/health-metrics|health-alert-state|workflow-health/.test(file.path)));
  assert.ok(verified.files.every((file) => !/update\.lock|update-jobs/.test(file.path)));
  assert.ok(verified.files.every((file) => !file.path.includes("update-notification-state.json")));
  assert.ok(verified.files.every((file) => !file.path.includes("/.index/") && !file.path.includes("/.graph/")));
  assert.ok(verified.files.every((file) => !file.path.startsWith("payload/vault/data/")), "vault-only recovery must not imply application-data recovery");
  assertPrivate(backup);
  assertPrivate(join(backup, "backup.json"));
  for (const file of verified.files) assertPrivate(join(backup, file.path));

  mkdirSync(target, { recursive: true });
  copyFileSync(join(ROOT, "package.json"), join(target, "package.json"));
  const restored = restorePortableBackup({ root: target, backupDir: backup, writersStopped: true, force: true });
  assert.equal(restored.profile, "local");
  assert.equal(callTaskTool(join(target, "data"), { action: "list", includeDone: true }).tasks[0].text, "restored task");
  assert.equal((await loadReminders(join(target, "data/reminders.json")))[0].text, "restored reminder");
  assert.equal(readFileSync(join(target, ".eve/.workflow-data/session-marker.json"), "utf8"), '{"session":"durable-local-session"}\n');
  assert.ok(existsSync(join(target, "data/telegram-userbot.session")), "full backup must restore opt-in session state");
  assert.ok(!existsSync(join(target, "vault/.index")) && !existsSync(join(target, "vault/.graph")), "derived indexes must be rebuilt");

  process.env.ASSISTANT_VAULT_DIR = join(target, "vault");
  process.env.MEMORY_SEARCH_MODE = "bm25";
  delete process.env.MEMORY_EMBED_URL;
  delete process.env.JINA_API_KEY;
  delete process.env.DEEPINFRA_API_KEY;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith("/embeddings.js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      return nextResolve(specifier, context);
    },
  });
  const { searchMemory } = await import("../agent/tools/memory_search.ts");
  const memory = await searchMemory({ query: "amber orchard 731", limit: 3, scope: ["cards"] });
  assert.ok(memory.count >= 1);
  assert.equal(memory.hits[0].file, "cards/canary-fact.md");
  assert.deepEqual(createCapabilityManifest(), beforeCapabilities, "restoring state must not change the code capability contract");
  assert.throws(() => restorePortableBackup({
    root: target,
    backupDir: backup,
    writersStopped: true,
    force: true,
    targetEnvironment: { ASSISTANT_DATA_DIR: target },
  }), /unsafe managed target|directories overlap/, "restore accepted a data directory that overlaps the code root");

  const tampered = join(backup, "payload/data/tasks.json");
  writeFileSync(tampered, "tampered\n", { mode: 0o600 });
  assert.throws(() => verifyPortableBackup(backup), /checksum or file inventory mismatch/);
  console.log("backup restore checks passed: inventory, privacy, checksums, local session, tasks, reminders, memory, derived rebuild");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
