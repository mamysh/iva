import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
export const REMINDERS_FILE = join(DATA_DIR, "reminders.json");
export const DEFAULT_TIMEZONE = process.env.ASSISTANT_TIMEZONE || "Europe/Minsk";

const STATUSES = new Set(["pending", "sending", "delivery_unknown", "sent", "cancelled", "failed"]);
const REPEATS = new Set(["none", "daily", "weekly", "monthly"]);

export async function loadReminders(file = REMINDERS_FILE) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeReminder).filter(Boolean);
  } catch {
    return [];
  }
}

export async function saveReminders(reminders, file = REMINDERS_FILE) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(reminders.map(normalizeReminder).filter(Boolean), null, 2)}\n`, "utf8");
}

export function nextReminderId(reminders) {
  return reminders.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
}

export function resolveDueAt({ dueAt, dueAtLocal, dueInMinutes, dueInSeconds, timezone = DEFAULT_TIMEZONE }) {
  if (dueInSeconds !== undefined && dueInSeconds !== null) {
    const n = Number(dueInSeconds);
    if (!Number.isFinite(n) || n < 0) throw new Error("dueInSeconds must be a non-negative number");
    return new Date(Date.now() + Math.round(n * 1000));
  }
  if (dueInMinutes !== undefined && dueInMinutes !== null) {
    const n = Number(dueInMinutes);
    if (!Number.isFinite(n) || n < 0) throw new Error("dueInMinutes must be a non-negative number");
    return new Date(Date.now() + Math.round(n * 60_000));
  }
  if (dueAtLocal) return zonedLocalToUtc(String(dueAtLocal), timezone);
  if (dueAt) {
    const d = new Date(dueAt);
    if (Number.isNaN(d.getTime())) throw new Error("dueAt must be an ISO date");
    return d;
  }
  throw new Error("Set dueAt, dueAtLocal, dueInMinutes, or dueInSeconds");
}

export function createReminder(input, existing = []) {
  const now = new Date().toISOString();
  const timezone = input.timezone || DEFAULT_TIMEZONE;
  const due = resolveDueAt({ ...input, timezone });
  const repeat = normalizeRepeat(input.repeat);
  const reminder = {
    id: nextReminderId(existing),
    text: String(input.text || "").trim(),
    dueAt: due.toISOString(),
    timezone,
    chatId: input.chatId ? String(input.chatId) : null,
    userId: input.userId ? String(input.userId) : null,
    priority: input.priority || "med",
    repeat,
    repeatInterval: Math.max(1, Math.trunc(Number(input.repeatInterval || 1))),
    repeatUntil: input.repeatUntil ? new Date(input.repeatUntil).toISOString() : null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    lastSentAt: null,
    sentCount: 0,
    attempts: 0,
    lastError: null,
    deliveryId: null,
    deliveryClaimedAt: null,
  };
  if (!reminder.text) throw new Error("text must not be empty");
  if (reminder.repeatUntil && Number.isNaN(new Date(reminder.repeatUntil).getTime())) {
    throw new Error("repeatUntil must be an ISO date");
  }
  return reminder;
}

export function formatReminder(reminder, { now = new Date(), timezone = reminder.timezone || DEFAULT_TIMEZONE } = {}) {
  const due = new Date(reminder.dueAt);
  const rel = due.getTime() <= now.getTime() ? "now/overdue" : formatLocal(due, timezone);
  const repeat = reminder.repeat && reminder.repeat !== "none" ? `, repeat: ${reminder.repeat}/${reminder.repeatInterval}` : "";
  return `#${reminder.id} [${reminder.status}] ${rel}${repeat} - ${reminder.text}`;
}

export function duePending(reminders, now = new Date()) {
  return reminders.filter((item) => item.status === "pending" && new Date(item.dueAt).getTime() <= now.getTime());
}

export function markDelivered(reminder, sentAt = new Date()) {
  const stamp = sentAt.toISOString();
  reminder.lastSentAt = stamp;
  reminder.sentAt = stamp;
  reminder.sentCount = Number(reminder.sentCount || 0) + 1;
  reminder.attempts = 0;
  reminder.lastError = null;
  reminder.deliveryClaimedAt = null;
  reminder.updatedAt = stamp;

  if (reminder.repeat && reminder.repeat !== "none") {
    const next = nextRepeatDate(new Date(reminder.dueAt), reminder.repeat, reminder.repeatInterval || 1);
    if (reminder.repeatUntil && next.getTime() > new Date(reminder.repeatUntil).getTime()) {
      reminder.status = "sent";
    } else {
      reminder.dueAt = next.toISOString();
      reminder.status = "pending";
      reminder.sentAt = null;
    }
  } else {
    reminder.status = "sent";
  }
}

export function claimDelivery(reminder, claimedAt = new Date()) {
  if (reminder.status !== "pending") throw new Error(`Cannot claim reminder in status ${reminder.status}`);
  const stamp = claimedAt.toISOString();
  reminder.status = "sending";
  reminder.deliveryId = `${reminder.id}:${Number(reminder.sentCount || 0) + 1}:${reminder.dueAt}`;
  reminder.deliveryClaimedAt = stamp;
  reminder.updatedAt = stamp;
  return reminder.deliveryId;
}

export function markDeliveryUnknown(reminder, error, at = new Date()) {
  reminder.status = "delivery_unknown";
  reminder.lastError = String(error || "delivery result unknown").slice(0, 500);
  reminder.updatedAt = at.toISOString();
}

export function recoverInterruptedDeliveries(reminders, at = new Date()) {
  let recovered = 0;
  for (const reminder of reminders) {
    if (reminder.status !== "sending") continue;
    markDeliveryUnknown(reminder, "dispatcher stopped after claiming delivery; not retried to avoid a duplicate", at);
    recovered++;
  }
  return recovered;
}

export function markFailedAttempt(reminder, error, maxAttempts = 20) {
  reminder.attempts = Number(reminder.attempts || 0) + 1;
  reminder.lastError = String(error || "unknown").slice(0, 500);
  reminder.updatedAt = new Date().toISOString();
  reminder.deliveryClaimedAt = null;
  reminder.status = reminder.attempts >= maxAttempts ? "failed" : "pending";
}

function normalizeReminder(item) {
  if (!item || typeof item !== "object") return null;
  const status = STATUSES.has(item.status) ? item.status : "pending";
  const repeat = normalizeRepeat(item.repeat);
  const due = new Date(item.dueAt);
  if (!item.id || !item.text || Number.isNaN(due.getTime())) return null;
  return {
    id: Number(item.id),
    text: String(item.text),
    dueAt: due.toISOString(),
    timezone: item.timezone || DEFAULT_TIMEZONE,
    chatId: item.chatId ? String(item.chatId) : null,
    userId: item.userId ? String(item.userId) : null,
    priority: item.priority || "med",
    repeat,
    repeatInterval: Math.max(1, Math.trunc(Number(item.repeatInterval || 1))),
    repeatUntil: item.repeatUntil || null,
    status,
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
    sentAt: item.sentAt || null,
    lastSentAt: item.lastSentAt || null,
    sentCount: Number(item.sentCount || 0),
    attempts: Number(item.attempts || 0),
    lastError: item.lastError || null,
    deliveryId: item.deliveryId || null,
    deliveryClaimedAt: item.deliveryClaimedAt || null,
  };
}

function normalizeRepeat(repeat) {
  const r = repeat || "none";
  return REPEATS.has(r) ? r : "none";
}

function nextRepeatDate(date, repeat, interval) {
  const n = Math.max(1, Math.trunc(Number(interval || 1)));
  const d = new Date(date);
  if (repeat === "daily") d.setUTCDate(d.getUTCDate() + n);
  else if (repeat === "weekly") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (repeat === "monthly") d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

function formatLocal(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function zonedLocalToUtc(local, timezone) {
  const m = String(local).trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (!m) throw new Error("dueAtLocal must be YYYY-MM-DDTHH:mm[:ss]");
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s),
  };
  let utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  for (let i = 0; i < 3; i++) {
    utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
      timeZoneOffsetMs(timezone, new Date(utc));
  }
  const out = new Date(utc);
  if (Number.isNaN(out.getTime())) throw new Error(`Could not parse date in timezone ${timezone}`);
  return out;
}

function timeZoneOffsetMs(timezone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUTC - date.getTime();
}
