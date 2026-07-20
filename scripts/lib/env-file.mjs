import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { MODEL_CATALOG } from "./model-catalog.mjs";

const LINE_RE = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/;

export const MODEL_CONFIG_KEYS = Object.freeze([
  "MODEL_PROVIDER",
  "VISION_PROVIDER",
  "THINKING_EFFORT",
  ...Object.values(MODEL_CATALOG).flatMap(({ textModelSelector, visionModelSelector }) => [
    textModelSelector,
    visionModelSelector,
  ]),
]);
const MODEL_CONFIG_KEY_SET = new Set(MODEL_CONFIG_KEYS);

export function parseEnvText(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(LINE_RE);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

export async function readEnvValues(path) {
  try {
    return parseEnvText(await readFile(path, "utf8"));
  } catch {
    return {};
  }
}

export function renderModelEnv(text, updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (!MODEL_CONFIG_KEY_SET.has(key)) throw new Error(`model env key is not allowed: ${key}`);
    if (value != null && /[\n\r]/.test(String(value))) throw new Error(`env value for ${key} contains a newline`);
  }

  const lines = String(text).length ? String(text).split(/\r?\n/) : [];
  if (lines.at(-1) === "") lines.pop();
  const pending = new Map(Object.entries(updates).map(([key, value]) => [key, value == null ? null : String(value).trim()]));
  const out = [];
  for (const line of lines) {
    const key = line.match(LINE_RE)?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key);
      pending.delete(key);
      if (value !== null) out.push(`${key}=${value}`);
      continue;
    }
    if (key && Object.hasOwn(updates, key) && !pending.has(key)) continue;
    out.push(line);
  }
  for (const [key, value] of pending) if (value !== null) out.push(`${key}=${value}`);
  return `${out.join("\n")}\n`;
}

// Surgical model-config editor for the Telegram picker. It preserves comments, blank lines,
// unknown settings and order; only an explicit allowlist can change. Writes are atomic and always
// tighten .env to 0600 because the same file contains provider and Telegram credentials.
export async function upsertModelEnv(path, updates) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    /* New file. */
  }

  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "w", 0o600);
    await handle.writeFile(renderModelEnv(text, updates), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}
