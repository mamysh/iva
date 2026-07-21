import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock, releaseUpdateLock } from "./update-lock.mjs";
import {
  createTelegramUpdateJob,
  createTelegramUpdateReporter,
  loadTelegramUpdateJob,
  removeTelegramUpdateJob,
  renderUpdateProgress,
  renderUpdateResult,
  UPDATE_PHASES,
} from "./update-progress.mjs";

test("update lock blocks a concurrent entrypoint and only its owner can release it", () => {
  const directory = mkdtempSync(join(tmpdir(), "iva-update-lock-"));
  try {
    const first = acquireUpdateLock(directory, { source: "telegram", token: "first" });
    const second = acquireUpdateLock(directory, { source: "cli", token: "second" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.owner.source, "telegram");
    assert.equal(releaseUpdateLock({ ...first, token: "wrong" }), false);
    assert.equal(acquireUpdateLock(directory, { token: "third" }).ok, false);
    assert.equal(releaseUpdateLock(first), true);
    const third = acquireUpdateLock(directory, { token: "third" });
    assert.equal(third.ok, true);
    releaseUpdateLock(third);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("update lock recovers a dead owner without stealing a live lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "iva-update-stale-lock-"));
  try {
    const first = acquireUpdateLock(directory, { token: "dead" });
    const ownerPath = join(first.path, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 999_999 }), { mode: 0o600 });
    const recovered = acquireUpdateLock(directory, { token: "recovered", isProcessAlive: () => false });
    assert.equal(recovered.ok, true);
    releaseUpdateLock(recovered);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Telegram update job is private, opaque and path-safe", () => {
  const directory = mkdtempSync(join(tmpdir(), "iva-update-job-"));
  try {
    const created = createTelegramUpdateJob(directory, { chatId: -1001, messageId: 42, locale: "ru" });
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    assert.equal(statSync(created.path).mode & 0o777, 0o600);
    assert.deepEqual(loadTelegramUpdateJob(directory, created.id)?.job, {
      schemaVersion: 1,
      chatId: "-1001",
      messageId: 42,
      locale: "ru",
    });
    assert.equal(loadTelegramUpdateJob(directory, "../../.env"), null);
    removeTelegramUpdateJob(created.path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Telegram update edits the original message through phases and final success", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: url.split("/").at(-1), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "secret",
    job: { chatId: 7, messageId: 99, locale: "ru" },
    fetchImpl,
  });
  for (const phase of UPDATE_PHASES) await reporter.phase(phase);
  await reporter.complete({ outcome: "updated", currentCommit: "123456789", targetCommit: "abcdef012" });

  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 0);
  assert.ok(calls.every((call) => call.method === "editMessageText"));
  assert.ok(calls.every((call) => call.body.chat_id === "7" && call.body.message_id === 99));
  assert.match(calls.at(-1).body.text, /Iva обновлена/);
  assert.match(calls.at(-1).body.text, /1234567 → abcdef0/);
});

test("Telegram failure cannot affect update outcome and creates at most one final fallback", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push({ method, body: JSON.parse(init.body) });
    if (method === "editMessageText") {
      return { ok: false, status: 400, json: async () => ({ ok: false, description: "message can't be edited" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
  };
  const reporter = createTelegramUpdateReporter({
    token: "secret",
    job: { chatId: 7, messageId: 99, locale: "en" },
    fetchImpl,
  });
  await assert.doesNotReject(reporter.phase("target"));
  const result = { outcome: "rolled_back", reason: "target readiness failed" };
  await assert.doesNotReject(reporter.complete(result));
  await assert.doesNotReject(reporter.complete(result));
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
  assert.match(calls.find((call) => call.method === "sendMessage").body.text, /previous version is active/i);
});

test("progress copy preserves phase order and distinguishes blocked from rollback", () => {
  const progress = renderUpdateProgress("verification", "en");
  assert.ok(progress.indexOf("Checking configuration") < progress.indexOf("Running tests and build"));
  assert.match(progress, /◇ Running tests and build/);
  assert.match(renderUpdateResult({ outcome: "blocked" }, "en"), /already running/);
  assert.doesNotMatch(renderUpdateResult({ outcome: "blocked" }, "en"), /rolled back/i);
});
