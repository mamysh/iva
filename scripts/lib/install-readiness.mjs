export const INSTALL_SERVICES = ["iva.service", "iva-telegram-poll.service"];

export function evaluateInstallReadiness(observation) {
  const issues = [];

  if (!observation.configured) issues.push("configuration incomplete");
  if (!observation.buildPresent) issues.push("production build missing");
  if (!observation.systemdAvailable) issues.push("systemd user services unavailable");
  if (!observation.healthOk) issues.push("Eve health endpoint not ready");
  if (!observation.stableHealthOk) issues.push("Eve did not remain healthy");

  for (const name of INSTALL_SERVICES) {
    const service = observation.services?.[name];
    if (!service?.active) issues.push(`${name} inactive`);
    if ((service?.restarts ?? 0) > 2) issues.push(`${name} restart loop detected`);
    if (service?.terminalError) issues.push(`${name} has a fresh terminal startup error`);
  }

  if (!observation.configured) {
    return {
      status: "configuration_pending",
      ready: false,
      issues,
      resume: "npm run setup && bash install.sh",
    };
  }

  if (issues.length) {
    return {
      status: "readiness_failed",
      ready: false,
      issues,
      resume: "iva doctor && bash install.sh",
    };
  }

  return { status: "ready", ready: true, issues: [], resume: null };
}
