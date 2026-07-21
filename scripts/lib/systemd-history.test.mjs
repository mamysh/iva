#!/usr/bin/env node
import assert from "node:assert/strict";
import { lastSuccessfulUnitRun } from "./systemd-history.mjs";

function reader(properties) {
  return (unit, property) => properties[`${unit}:${property}`] || "";
}

const service = "iva-memory-doctor.service";
const timer = "iva-memory-doctor.timer";
const completed = {
  [`${service}:ExecMainStatus`]: "0",
  [`${service}:Result`]: "success",
  [`${service}:ActiveState`]: "inactive",
};

assert.equal(lastSuccessfulUnitRun(service, reader({
  ...completed,
  [`${service}:ExecMainStartTimestamp`]: "Tue 2026-07-21 07:59:27 UTC",
  [`${timer}:LastTriggerUSec`]: "Tue 2026-07-21 05:00:15 UTC",
})), "2026-07-21T07:59:27.000Z", "the service timestamp must win after a manual run");

assert.equal(lastSuccessfulUnitRun(service, reader({
  ...completed,
  [`${service}:ExecMainStartTimestamp`]: "",
  [`${timer}:LastTriggerUSec`]: "Mon 2026-07-20 05:00:08 UTC",
})), "2026-07-20T05:00:08.000Z", "a successful timer trigger must survive lost oneshot metadata");

for (const properties of [
  { ...completed, [`${service}:ExecMainStatus`]: "1", [`${service}:Result`]: "exit-code" },
  { ...completed, [`${service}:Result`]: "timeout" },
  { ...completed, [`${service}:ActiveState`]: "activating" },
]) {
  properties[`${timer}:LastTriggerUSec`] = "Tue 2026-07-21 05:00:15 UTC";
  assert.equal(lastSuccessfulUnitRun(service, reader(properties)), null, "failed or running work must not reuse the timer trigger");
}

assert.equal(lastSuccessfulUnitRun(service, reader(completed)), null, "a never-triggered service has no success evidence");
assert.equal(lastSuccessfulUnitRun("iva-manual.service", reader({
  "iva-manual.service:ExecMainStatus": "0",
  "iva-manual.service:Result": "success",
  "iva-manual.service:ActiveState": "inactive",
})), null, "a successful default Result without execution timestamps is not evidence of a run");

console.log("systemd history checks passed: direct success, reload fallback and failure guards");
