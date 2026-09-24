import { readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { notificationChat } from "../lib/notification-chat.ts";
import type { ReminderChat } from "../lib/reminder-store.ts";
import { chatOfTurn } from "../lib/reminder-tool.ts";
import { vaultDirErrorText } from "../lib/vault-error.ts";
import {
  resolveVaultToolPath,
  resolveVaultToolRoot,
} from "../lib/vault-file-search.ts";

// Штатная отправка файла в чат хода. Гвард bash режет curl в api.telegram.org, поэтому
// файл уходит только отсюда и только из Vault или временного каталога ОС: .env, data/ и
// ключи не уезжают даже по симлинку — судим реальный путь.

// Предел Bot API на sendDocument.
export const MAX_BYTES = 50 * 1024 * 1024;

export type SendFileSent = {
  readonly ok: true;
  readonly name: string;
  readonly bytes: number;
  readonly message_id: number | null;
};
export type SendFileFailure = { readonly ok: false; readonly error: string };
export type SendFileAnswer = SendFileSent | SendFileFailure;
type Readable = { readonly name: string; readonly data: Buffer };

const fail = (error: string): SendFileFailure => ({ ok: false, error });

const OUTSIDE =
  "отправлять можно только файлы из Vault и временного каталога: положи файл в " +
  "vault/attachments/<дата>/ и вызови send_file ещё раз";

function inside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Корни и как заданы, и после симлинков: несуществующий путь судим по записи, чтобы
// отказ «не найден» не выдавал, есть ли файл снаружи.
async function allowedRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const dir of [resolveVaultToolRoot(), tmpdir()]) {
    // Нет каталога — нет и файлов в нём: остаётся корень как задан.
    const real = await realpath(dir).catch(() => null);
    roots.push(dir, ...(real === null ? [] : [real]));
  }
  return roots;
}

async function readAllowed(
  path: string,
  maxBytes: number,
): Promise<Readable | SendFileFailure> {
  let resolved: string;
  try {
    resolved = resolveVaultToolPath(path);
  } catch (error) {
    const text = vaultDirErrorText(error);
    if (text !== null) return fail(text);
    throw error;
  }
  const roots = await allowedRoots();
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return fail(
      roots.some((root) => inside(root, resolved))
        ? `файл не найден: ${path}`
        : OUTSIDE,
    );
  }
  // Реальный путь без симлинков лежит под корнем, только если корень сам без них:
  // симлинк из Vault наружу не проходит.
  if (!roots.some((root) => inside(root, real))) return fail(OUTSIDE);
  const info = await stat(real);
  if (info.isDirectory())
    return fail(`${path} - это каталог, а не файл; укажи файл`);
  if (!info.isFile()) return fail(`${path} - не обычный файл`);
  if (info.size > maxBytes)
    return fail(
      `файл ${info.size} байт больше предела Telegram в 50 МБ; сожми или разбей его`,
    );
  return { name: basename(real), data: await readFile(real) };
}

function telegramError(body: unknown, status: number): string {
  const description =
    typeof body === "object" && body !== null && "description" in body
      ? String(body.description)
      : `HTTP ${status}`;
  return `Telegram: ${description}`;
}

function messageId(body: unknown): number | null {
  const result = (body as { result?: { message_id?: unknown } } | null)?.result;
  return typeof result?.message_id === "number" ? result.message_id : null;
}

function documentForm(
  chatId: string,
  threadId: string | null,
  caption: string | undefined,
  file: Readable,
): FormData {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (threadId) form.append("message_thread_id", threadId);
  if (caption) form.append("caption", caption);
  form.append("document", new File([new Uint8Array(file.data)], file.name));
  return form;
}

async function postDocument(
  token: string,
  form: FormData,
  file: Readable,
): Promise<SendFileAnswer> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendDocument`,
      { method: "POST", body: form },
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || (body as { ok?: unknown } | null)?.ok !== true)
      return fail(telegramError(body, response.status));
    return {
      ok: true,
      name: file.name,
      bytes: file.data.byteLength,
      message_id: messageId(body),
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return fail(`отправка не удалась: ${text.replaceAll(token, "***")}`);
  }
}

// Чат хода с его темой; фоновый ход без чата - чат уведомлений владельца.
function targetChat(chat: ReminderChat | null): ReminderChat | null {
  if (chat !== null) return chat;
  const id = notificationChat(process.env);
  return id ? { id, threadId: null } : null;
}

export async function sendFile(
  { path, caption }: { readonly path: string; readonly caption?: string },
  chat: ReminderChat | null,
  { maxBytes = MAX_BYTES }: { readonly maxBytes?: number } = {},
): Promise<SendFileAnswer> {
  const target = targetChat(chat);
  if (target === null)
    return fail(
      "нет чата: ход не из Telegram, а TELEGRAM_DIGEST_CHAT_ID и TELEGRAM_ALLOWED_USER_IDS пусты",
    );
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) return fail("не задан TELEGRAM_BOT_TOKEN");
  const file = await readAllowed(path, maxBytes);
  if ("ok" in file) return file;
  const form = documentForm(target.id, target.threadId, caption, file);
  return postDocument(token, form, file);
}

export default defineTool({
  description:
    "Отправить файл документом в чат, где идёт разговор. path - файл из Vault " +
    "(от корня vault, vault/… или абсолютный) или из временного каталога; caption - подпись. " +
    "Возвращает { ok, name, bytes, message_id } или { ok: false, error }.",
  inputSchema: z.object({
    path: z
      .string()
      .min(1)
      .describe("Файл: от корня vault, vault/… или абсолютный"),
    caption: z
      .string()
      .max(1024)
      .optional()
      .describe("Подпись к файлу, до 1024 знаков"),
  }),
  async execute(input, ctx): Promise<SendFileAnswer> {
    try {
      return await sendFile(input, chatOfTurn(ctx));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});
