import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  normalizeUpdateChanges,
  readUpdateNotificationState,
  repairUpdateNotificationState,
  recordUpdateCheck,
  renderUpdateOffer,
  shouldNotifyUpdate,
  updateCheckEnabled,
  updateNotificationStatePath,
  updateOfferKeyboard,
} from "./update-notification.mjs";
import { runUpdateCheck } from "../update-check.mjs";

const directory = mkdtempSync(join(tmpdir(), "iva-update-notification-"));
const info = {
  channel: "origin/main", local: "a".repeat(40), remote: "b".repeat(40), behind: 2, rewritten: false,
  localVer: "0.3.0-rc.4", remoteVer: "0.3.0-rc.4", hasUpdate: true,
};

try {
  assert.equal(updateCheckEnabled({ IVA_UPDATE_CHECK_ENABLED: "true" }), true);
  assert.equal(updateCheckEnabled({ IVA_UPDATE_CHECK_ENABLED: "ON" }), true);
  assert.equal(updateCheckEnabled({ IVA_UPDATE_CHECK_ENABLED: "false" }), false);

  const empty = readUpdateNotificationState(directory);
  assert.equal(empty.lastNotifiedCommit, null);
  assert.equal(shouldNotifyUpdate(empty, info), true);

  const checked = recordUpdateCheck(directory, info, { notified: false, now: new Date("2026-07-21T10:00:00Z") });
  assert.equal(checked.lastCheckedCommit, info.remote);
  assert.equal(checked.lastNotifiedCommit, null);
  assert.equal(statSync(updateNotificationStatePath(directory)).mode & 0o077, 0);

  const notified = recordUpdateCheck(directory, info, { notified: true, now: new Date("2026-07-21T10:01:00Z") });
  assert.equal(shouldNotifyUpdate(notified, info), false, "same target was not deduplicated");
  const next = { ...info, remote: "c".repeat(40) };
  assert.equal(shouldNotifyUpdate(notified, next), true, "new commit with the same version must notify");

  assert.deepEqual(normalizeUpdateChanges("abc first\ndef second\n", 1), ["abc first"]);
  assert.match(renderUpdateOffer(info, { locale: "ru" }), /Автоустановка выключена/);
  assert.match(renderUpdateOffer(info, { locale: "en", detailed: true, changes: ["abc change"] }), /• abc change/);
  assert.deepEqual(
    updateOfferKeyboard({ locale: "ru", includeView: true }).inline_keyboard[0].map((button) => button.callback_data),
    ["iva_update:view", "iva_update:do", "iva_update:later"],
  );

  const baseState = { ...empty, lastNotifiedCommit: null };
  let acquired = 0;
  const disabled = await runUpdateCheck({
    env: { IVA_UPDATE_CHECK_ENABLED: "false" },
    acquireLock: () => { acquired += 1; return { ok: true }; },
  });
  assert.equal(disabled.outcome, "disabled");
  assert.equal(acquired, 0, "disabled check acquired the update lock");

  const busy = await runUpdateCheck({
    env: { IVA_UPDATE_CHECK_ENABLED: "true" },
    acquireLock: () => ({ ok: false }),
    inspect: () => assert.fail("busy check inspected Git"),
  });
  assert.equal(busy.outcome, "busy");

  const events = [];
  const notifiedResult = await runUpdateCheck({
    env: { IVA_UPDATE_CHECK_ENABLED: "true" },
    dataDir: directory,
    acquireLock: () => { events.push("acquire"); return { ok: true, token: "test" }; },
    releaseLock: () => events.push("release"),
    inspect: async () => { events.push("inspect"); return next; },
    readState: () => { events.push("read"); return baseState; },
    sendOffer: async () => events.push("send"),
    recordCheck: (_dataDir, _info, options) => events.push(options?.notified ? "record-notified" : "record"),
  });
  assert.equal(notifiedResult.outcome, "notified");
  assert.deepEqual(events, ["acquire", "inspect", "read", "send", "record-notified", "release"]);

  let releasedAfterFailure = false;
  await assert.rejects(runUpdateCheck({
    env: { IVA_UPDATE_CHECK_ENABLED: "true" },
    dataDir: directory,
    acquireLock: () => ({ ok: true, token: "test" }),
    releaseLock: () => { releasedAfterFailure = true; },
    inspect: async () => next,
    readState: () => baseState,
    sendOffer: async () => { throw new Error("synthetic Telegram failure"); },
  }), /synthetic Telegram failure/);
  assert.equal(releasedAfterFailure, true, "Telegram failure left the update lock held");

  const symlinkDir = mkdtempSync(join(tmpdir(), "iva-update-notification-link-"));
  try {
    symlinkSync(updateNotificationStatePath(directory), updateNotificationStatePath(symlinkDir));
    assert.throws(() => readUpdateNotificationState(symlinkDir), /not a regular file/);
    assert.throws(() => repairUpdateNotificationState(symlinkDir), /not a regular file/);
  } finally {
    rmSync(symlinkDir, { recursive: true, force: true });
  }

  const corruptDir = join(directory, "corrupt");
  mkdirSync(corruptDir, { recursive: true });
  writeFileSync(updateNotificationStatePath(corruptDir), "not json\n", { mode: 0o600 });
  assert.equal(repairUpdateNotificationState(corruptDir), true);
  assert.equal(readUpdateNotificationState(corruptDir).lastNotifiedCommit, null);
  assert.equal(repairUpdateNotificationState(corruptDir), false);

  console.log("update notification checks passed: opt-in, private atomic state, SHA dedup and Telegram offer");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
