import { readFileSync } from "node:fs";

/** A CLI child of iva.service dies when that service is stopped for a rebuild. */
export function inIvaServiceCgroup(
  read = () => readFileSync("/proc/self/cgroup", "utf8"),
): boolean {
  try {
    return read()
      .split("\n")
      .some((line) =>
        line.split(":", 3)[2]?.split("/").includes("iva.service"),
      );
  } catch {
    return false;
  }
}
