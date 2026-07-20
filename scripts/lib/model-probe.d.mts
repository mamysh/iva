export function runBoundedModelProbe(options: {
  root: string;
  role: "text" | "vision";
  env: Record<string, string | undefined>;
  node?: string;
  timeoutMs?: number;
  execute?: typeof import("node:child_process").execFile;
}): Promise<true>;
