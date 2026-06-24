#!/usr/bin/env node
// Short-lived reminder dispatcher.
//
// systemd timer runs this once per minute. It reads data/reminders.json, sends
// due reminders directly through Telegram Bot API, and exits. It never calls the
// Eve webhook, so reminders cannot keep a workflow turn alive or grow workflow data.
import { mkdir, rm, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DATA_DIR,
  DEFAULT_TIMEZONE,
  REMINDERS_FILE,
  duePending,
  formatReminder,
  loadReminders,
  markDelivered,
  markFailedAttempt,
  saveReminders,
} from "./lib/reminders-store.mjs";

const LOCK_DIR = join(DATA_DIR, ".reminders.lock");
const MAX_ATTEMPTS = Number(process.env.REMINDERS_MAX_ATTEMPTS || 20);
const TELEGRAM_LIMIT = 3900;

async function main() {
  if (process.argv.includes("--list")) return list();

  const unlock = await lock();
  if (!unlock) return;
  try {
    await dispatchDue();
  } finally {
    await unlock();
  }
}

async function list() {
  const reminders = await loadReminders();
  const items = reminders.filter((r) => r.status === "pending");
  if (!items.length) return console.log("Нет активных напоминаний.");
  for (const item of items) console.log(formatReminder(item));
}

async function dispatchDue() {
  const reminders = await loadReminders();
  const due = duePending(reminders);
  if (!due.length) return;

  let changed = false;
  for (const reminder of due) {
    try {
      await sendReminder(reminder);
      markDelivered(reminder);
      await appendReminderToDaily(reminder);
      changed = true;
      console.log(`sent reminder #${reminder.id}`);
    } catch (error) {
      markFailedAttempt(reminder, error, MAX_ATTEMPTS);
      changed = true;
      console.error(`reminder #${reminder.id} failed: ${String(error).slice(0, 300)}`);
    }
    await saveReminders(reminders);
  }
  if (changed) await saveReminders(reminders);
}

async function sendReminder(reminder) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = reminder.chatId || process.env.TELEGRAM_DIGEST_CHAT_ID ||
    (process.env.TELEGRAM_ALLOWED_USER_IDS || "").split(/[,\s]+/).find(Boolean);
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is missing");
  if (!chat) throw new Error("No chat id: set TELEGRAM_DIGEST_CHAT_ID or TELEGRAM_ALLOWED_USER_IDS");

  const text = `Напоминание: ${reminder.text}`;
  for (const chunk of chunks(text, TELEGRAM_LIMIT)) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: chunk }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function appendReminderToDaily(reminder) {
  const vault = resolveVault();
  if (!vault) return;
  const timezone = reminder.timezone || DEFAULT_TIMEZONE;
  const day = localPart(new Date(), timezone, "date");
  const time = localPart(new Date(), timezone, "time");
  const file = join(vault, "daily", `${day}.md`);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `\n## ${time} [reminder]\n${reminder.text}\n`, "utf8");
}

function resolveVault() {
  const raw = process.env.ASSISTANT_VAULT_DIR || "vault";
  const vault = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  return existsSync(vault) ? vault : null;
}

function localPart(date, timezone, kind) {
  const opts = kind === "date"
    ? { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }
    : { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false };
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", opts).formatToParts(date).map((p) => [p.type, p.value]));
  if (kind === "date") return `${parts.year}-${parts.month}-${parts.day}`;
  return `${parts.hour}:${parts.minute}`;
}

function chunks(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

async function lock() {
  try {
    await mkdir(LOCK_DIR, { recursive: false });
    return () => rm(LOCK_DIR, { recursive: true, force: true });
  } catch (error) {
    if (error && error.code === "EEXIST") return null;
    throw error;
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
