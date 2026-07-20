import { execFile } from "node:child_process";
import { join } from "node:path";

export function runBoundedModelProbe({ root, role, env, node = process.execPath, timeoutMs = 30_000, execute = execFile }) {
  if (!new Set(["text", "vision"]).has(role)) return Promise.reject(new Error("invalid model probe role"));
  return new Promise((resolve, reject) => {
    execute(
      node,
      [join(root, "scripts/model-config-probe.mjs"), role],
      { cwd: root, env, timeout: timeoutMs, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error || String(stdout).trim() !== "ok") {
          reject(new Error(`${role} capability probe failed`));
          return;
        }
        resolve(true);
      },
    );
  });
}
