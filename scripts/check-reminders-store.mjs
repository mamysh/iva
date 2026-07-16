import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createReminder,
  claimDelivery,
  duePending,
  loadReminders,
  markDelivered,
  markFailedAttempt,
  markDeliveryUnknown,
  recoverInterruptedDeliveries,
  resolveDueAt,
  saveReminders,
} from "./lib/reminders-store.mjs";

const dir = await mkdtemp(join(tmpdir(), "iva-reminders-"));
try {
  const file = join(dir, "reminders.json");

  const utc = resolveDueAt({ dueAtLocal: "2026-01-02T03:04:05", timezone: "UTC" });
  assert.equal(utc.toISOString(), "2026-01-02T03:04:05.000Z");

  const first = createReminder({
    text: "stretch",
    dueAt: "2026-01-02T03:04:05.000Z",
    timezone: "UTC",
    repeat: "daily",
    repeatInterval: 2,
  });
  assert.equal(first.id, 1);
  assert.equal(first.status, "pending");

  const second = createReminder({ text: "tea", dueAt: "2026-01-03T00:00:00.000Z" }, [first]);
  assert.equal(second.id, 2);

  await saveReminders([first, second], file);
  const loaded = await loadReminders(file);
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].dueAt, "2026-01-02T03:04:05.000Z");

  assert.equal(duePending(loaded, new Date("2026-01-02T03:04:06.000Z")).length, 1);

  const deliveryId = claimDelivery(loaded[0], new Date("2026-01-02T03:04:07.000Z"));
  assert.match(deliveryId, /^1:1:/);
  assert.equal(duePending(loaded, new Date("2026-01-02T03:04:08.000Z")).length, 0);
  assert.equal(recoverInterruptedDeliveries(loaded, new Date("2026-01-02T03:04:09.000Z")), 1);
  assert.equal(loaded[0].status, "delivery_unknown");
  assert.equal(duePending(loaded, new Date("2026-01-02T03:04:10.000Z")).length, 0);
  loaded[0].status = "sending";

  markDelivered(loaded[0], new Date("2026-01-02T03:05:00.000Z"));
  assert.equal(loaded[0].status, "pending");
  assert.equal(loaded[0].sentAt, null);
  assert.equal(loaded[0].dueAt, "2026-01-04T03:04:05.000Z");
  assert.equal(loaded[0].sentCount, 1);

  markFailedAttempt(loaded[1], new Error("telegram down"), 1);
  assert.equal(loaded[1].status, "failed");
  assert.match(loaded[1].lastError, /telegram down/);

  const ambiguous = createReminder({ text: "network", dueAt: "2026-01-01T00:00:00.000Z" }, loaded);
  claimDelivery(ambiguous);
  markDeliveryUnknown(ambiguous, new Error("socket closed"));
  assert.equal(ambiguous.status, "delivery_unknown");

  assert.deepEqual(await loadReminders(join(dir, "missing.json")), []);
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("reminders store checks passed");
