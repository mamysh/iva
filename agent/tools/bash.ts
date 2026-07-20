import { defineTool } from "eve/tools";
import { z } from "zod";
import { exec } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Host-native bash. Переопределяет встроенный sandbox-bash eve: команда выполняется
// напрямую на реальной файловой системе VPS через node:child_process (без sandbox).
// Самодостаточно: импортирует только eve/tools, zod и node-builtins.

const MAX_OUTPUT = 30_000; // оставляем последние ~30k символов каждого потока

function truncate(s: string): { text: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT) return { text: s, truncated: false };
  return { text: s.slice(s.length - MAX_OUTPUT), truncated: true };
}

// Host-native commands fail before execution when cwd does not exist or the service user cannot
// enter it. Normalize and validate here so the model gets an actionable result instead of mistaking
// a Node spawn error for command output. /workspace is intentionally not guessed or remapped.
export function normalizeCwd(cwd?: string): { cwd?: string; error?: string } {
  if (!cwd?.trim()) return {};
  const expanded = cwd === "~" ? homedir() : cwd.startsWith("~/") ? join(homedir(), cwd.slice(2)) : cwd;
  try {
    if (!statSync(expanded).isDirectory()) throw new Error("not a directory");
    accessSync(expanded, constants.X_OK);
    return { cwd: realpathSync(expanded) };
  } catch {
    return {
      error:
        `cwd "${cwd}"${expanded !== cwd ? ` → "${expanded}"` : ""}: не существует, не является ` +
        `доступной директорией или нет прав на вход. Сервис работает в ${process.cwd()}, ` +
        `HOME=${homedir()}. Повтори без cwd или укажи существующий host-путь (не /workspace).`,
    };
  }
}

export default defineTool({
  description:
    "Выполнить shell-команду НАПРЯМУЮ на хосте VPS (без sandbox, полный доступ к реальной " +
    "файловой системе и окружению). Возвращает { stdout, stderr, exitCode }. " +
    "Очень большой вывод обрезается до последних ~30000 символов каждого потока " +
    "(в этом случае добавляется пометка об усечении). " +
    "Используй для запуска любых команд: git, ls, uv, systemctl --user и т.д.",
  inputSchema: z.object({
    command: z.string().min(1).describe("Shell-команда для выполнения на хосте"),
    cwd: z
      .string()
      .optional()
      .describe(
        "Рабочая директория: абсолютный host-путь; ~ разворачивается в HOME. " +
          "/workspace не подставляется автоматически. Не уверен в пути — не указывай cwd.",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Таймаут в миллисекундах (по умолчанию 120000)"),
  }),
  async execute({ command, cwd, timeoutMs }) {
    const timeout = timeoutMs ?? 120_000;
    const normalized = normalizeCwd(cwd);
    if (normalized.error) return { stdout: "", stderr: normalized.error, exitCode: 1 };
    const runCwd = normalized.cwd ?? process.cwd();
    return await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      cwd: string;
      truncated?: boolean;
      timedOut?: boolean;
    }>((resolve) => {
      exec(
        command,
        { cwd: runCwd, timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => {
          const out = truncate(stdout ?? "");
          const err = truncate(stderr ?? "");
          // error.code — числовой код выхода; для таймаута node ставит error.killed=true.
          const e = error as (Error & { code?: number; killed?: boolean }) | null;
          const exitCode = e?.code ?? (error ? 1 : 0);
          resolve({
            stdout: out.text,
            stderr: err.text,
            exitCode,
            cwd: runCwd,
            truncated: out.truncated || err.truncated || undefined,
            timedOut: e?.killed || undefined,
          });
        },
      );
    });
  },
});
