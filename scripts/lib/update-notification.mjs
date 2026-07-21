import { randomUUID } from "node:crypto";
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const UPDATE_NOTIFICATION_SCHEMA_VERSION = 1;
export const UPDATE_NOTIFICATION_STATE_FILE = "update-notification-state.json";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export function updateCheckEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env.IVA_UPDATE_CHECK_ENABLED || "").trim());
}

function emptyState() {
  return {
    schemaVersion: UPDATE_NOTIFICATION_SCHEMA_VERSION,
    lastCheckedAt: null,
    lastCheckedCommit: null,
    lastResult: null,
    lastNotifiedAt: null,
    lastNotifiedCommit: null,
  };
}

function nullableString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("update notification state must be an object");
  }
  if (value.schemaVersion !== UPDATE_NOTIFICATION_SCHEMA_VERSION) {
    throw new Error("unsupported update notification state schema");
  }
  const state = {
    schemaVersion: UPDATE_NOTIFICATION_SCHEMA_VERSION,
    lastCheckedAt: nullableString(value.lastCheckedAt),
    lastCheckedCommit: nullableString(value.lastCheckedCommit),
    lastResult: nullableString(value.lastResult),
    lastNotifiedAt: nullableString(value.lastNotifiedAt),
    lastNotifiedCommit: nullableString(value.lastNotifiedCommit),
  };
  if (state.lastResult && !["available", "current"].includes(state.lastResult)) {
    throw new Error("invalid update notification result");
  }
  for (const key of ["lastCheckedCommit", "lastNotifiedCommit"]) {
    if (state[key] && !/^[0-9a-f]{7,64}$/i.test(state[key])) throw new Error(`invalid ${key}`);
  }
  for (const key of ["lastCheckedAt", "lastNotifiedAt"]) {
    if (state[key] && !Number.isFinite(Date.parse(state[key]))) throw new Error(`invalid ${key}`);
  }
  return state;
}

export function updateNotificationStatePath(dataDir) {
  return join(dataDir, UPDATE_NOTIFICATION_STATE_FILE);
}

export function readUpdateNotificationState(dataDir) {
  const path = updateNotificationStatePath(dataDir);
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("update notification state is not a regular file");
  try {
    return validateState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new Error(`invalid update notification state: ${error.message}`);
  }
}

export function writeUpdateNotificationState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const path = updateNotificationStatePath(dataDir);
  let info;
  try { info = lstatSync(path); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (info) {
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("update notification state is not a regular file");
  }
  const validated = validateState(state);
  const temporary = join(dataDir, `.${UPDATE_NOTIFICATION_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    chmodSync(temporary, PRIVATE_FILE_MODE);
    renameSync(temporary, path);
    chmodSync(path, PRIVATE_FILE_MODE);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, state: validated };
}

export function repairUpdateNotificationState(dataDir) {
  try {
    readUpdateNotificationState(dataDir);
    return false;
  } catch (error) {
    const path = updateNotificationStatePath(dataDir);
    let info;
    try { info = lstatSync(path); }
    catch { throw error; }
    // This is derived deduplication state, so malformed regular files are safe to
    // replace. Keep fail-closed behavior for symlinks and other special files.
    if (!info.isFile() || info.isSymbolicLink()) throw error;
    writeUpdateNotificationState(dataDir, emptyState());
    return true;
  }
}

export function shouldNotifyUpdate(state, info) {
  return Boolean(info?.hasUpdate && info.remote && state?.lastNotifiedCommit !== info.remote);
}

export function recordUpdateCheck(dataDir, info, { notified = false, now = new Date() } = {}) {
  const previous = readUpdateNotificationState(dataDir);
  const checkedAt = now.toISOString();
  return writeUpdateNotificationState(dataDir, {
    ...previous,
    lastCheckedAt: checkedAt,
    lastCheckedCommit: info.remote,
    lastResult: info.hasUpdate ? "available" : "current",
    ...(notified ? { lastNotifiedAt: checkedAt, lastNotifiedCommit: info.remote } : {}),
  }).state;
}

export function updateLocale(env = process.env) {
  return /(^|[-_])ru($|[-_])/i.test(env.AGENT_LANGUAGE || env.LANG || "") ? "ru" : "en";
}

function bumpLabel(info) {
  return info.remoteVer && info.remoteVer !== info.localVer
    ? `v${info.localVer ?? "?"} → v${info.remoteVer}`
    : `${info.local.slice(0, 7)} → ${info.remote.slice(0, 7)}`;
}

export function normalizeUpdateChanges(value, limit = 5) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180))
    .filter(Boolean)
    .slice(0, limit);
}

export function renderUpdateOffer(info, { locale = "en", detailed = false, changes = [] } = {}) {
  const ru = locale === "ru";
  const bump = bumpLabel(info);
  const count = Number(info.behind || 0);
  const history = info.rewritten
    ? (ru ? "История deployment-ветки изменилась; transactional updater проверит замену commit." : "Deployment history changed; the transactional updater will verify the commit replacement.")
    : (ru ? `Новых commit: ${count}.` : `${count} new commit${count === 1 ? "" : "s"}.`);
  const lines = [
    ru ? `🆕 Доступно обновление Iva: ${bump}` : `🆕 Iva update available: ${bump}`,
    history,
    ru ? `Канал: ${info.channel}. Автоустановка выключена.` : `Channel: ${info.channel}. Automatic installation is off.`,
  ];
  const normalized = normalizeUpdateChanges(changes);
  if (detailed) {
    lines.push("", ru ? "Изменения:" : "Changes:");
    if (normalized.length) lines.push(...normalized.map((line) => `• ${line}`));
    else lines.push(ru ? "• Список commit недоступен; target будет полностью проверен перед активацией." : "• Commit list unavailable; the target will still be fully verified before activation.");
  }
  return lines.join("\n");
}

export function updateOfferKeyboard({ locale = "en", includeView = false } = {}) {
  const ru = locale === "ru";
  return {
    inline_keyboard: [[
      ...(includeView ? [{ text: ru ? "👀 Посмотреть" : "👀 View", callback_data: "iva_update:view" }] : []),
      { text: ru ? "⬆️ Обновить" : "⬆️ Update", callback_data: "iva_update:do" },
      { text: ru ? "Позже" : "Later", callback_data: "iva_update:later" },
    ]],
  };
}
