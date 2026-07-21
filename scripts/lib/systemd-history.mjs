function isoTimestamp(value) {
  const timestamp = Date.parse(String(value || "").trim());
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function timerForService(unit) {
  return unit.endsWith(".service") ? `${unit.slice(0, -".service".length)}.timer` : null;
}

// systemd can discard ExecMainStartTimestamp for an inactive oneshot after its unit is
// rewritten/reloaded. The timer's last trigger survives that reload. It is a valid fallback only
// when the service still reports a successful completed result; a failed or running service must
// never inherit the timer timestamp as evidence of success.
export function lastSuccessfulUnitRun(unit, readValue) {
  const value = (target, property) => {
    try {
      return String(readValue(target, property) || "").trim();
    } catch {
      return "";
    }
  };

  if (Number.parseInt(value(unit, "ExecMainStatus"), 10) !== 0) return null;
  const result = value(unit, "Result");
  if (result && result !== "success") return null;
  if (["active", "activating", "reloading"].includes(value(unit, "ActiveState"))) return null;

  const direct = isoTimestamp(value(unit, "ExecMainStartTimestamp"));
  if (direct) return direct;

  const timer = timerForService(unit);
  if (!timer || result !== "success") return null;
  return isoTimestamp(value(timer, "LastTriggerUSec"));
}
