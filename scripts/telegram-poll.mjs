#!/usr/bin/env node
// Telegram long-polling bridge → local eve webhook route.
//
//   node --env-file=.env scripts/telegram-poll.mjs
//
// The eve Telegram channel works ONLY via webhook (POST /eve/v1/telegram, validating
// the X-Telegram-Bot-Api-Secret-Token header). On a bare VPS there is no public HTTPS,
// so we fetch updates from Telegram ourselves (getUpdates, long-poll) and POST them to
// the local eve route with the same secret — Telegram sees an ordinary bot, no proxy needed.
// The channel/agent are unchanged. Webhook and polling are mutually exclusive → deleteWebhook on start.
import { chmod, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { readEntries, summarize, formatUsageReport, parseWindow } from "./lib/usage.mjs";
import { loadReminders, formatReminder } from "./lib/reminders-store.mjs";
import { CONTROL_COMMANDS, checkDeploymentUpdate, parseUpdateAction } from "./lib/telegram-update.mjs";
import { readEnvValues } from "./lib/env-file.mjs";
import { providerAccessConfigured } from "./lib/model-catalog.mjs";
import { ModelWizard } from "./lib/model-wizard.mjs";
import { applyModelSelection } from "./lib/model-config-transaction.mjs";
import { runBoundedModelProbe } from "./lib/model-probe.mjs";
import { listConfiguredModels } from "./lib/model-inventory.mjs";
import { resolveUpdateChannel } from "./lib/update-channel.mjs";
import {
  createTelegramUpdateJob, removeTelegramUpdateJob, renderUpdateProgress,
} from "./lib/update-progress.mjs";
import {
  normalizeUpdateChanges, renderUpdateOffer, updateLocale, updateOfferKeyboard,
} from "./lib/update-notification.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
const PORT = process.env.IVA_PORT ?? "8723";
const HOST = (process.env.ASSISTANT_HOST ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const DATA_DIR = process.env.ASSISTANT_DATA_DIR ?? "data";
const DATA_PATH = isAbsolute(DATA_DIR) ? DATA_DIR : join(ROOT, DATA_DIR);
const ENV_PATH = join(ROOT, ".env");
const ROUTE = `${HOST}/eve/v1/telegram`;
const API = `https://api.telegram.org/bot${TOKEN}`;
const OFFSET_FILE = join(DATA_DIR, "telegram-offset.json");
// Pause between updates of the SAME chat: we give eve time to park the turn and register
// the continuation hook, otherwise a burst starts a second run on the same token → HookConflictError.
const SETTLE_MS = Number(process.env.TELEGRAM_POLL_SETTLE_MS ?? 1500);

// Trusted IDs — only they are allowed control commands (/restart etc.).
const ALLOWED = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
);

const HELP = [
  "Iva commands:",
  "/help — this list",
  "/restart — restart the agent if it's stuck",
  "/update — check for a new version and install it",
  "/model — choose text and vision models independently",
  "/think — choose text reasoning depth",
  "/new — start over (reset the current conversation)",
  "/task <text> — add a task",
  "/tasks — show tasks",
  "/reminders — show active reminders",
  "/digest — morning digest",
  "/usage [today|week|month|by-model|by-source] — token usage",
].join("\n");

if (!TOKEN) {
  console.error("telegram-poll: no TELEGRAM_BOT_TOKEN in .env — nothing to poll.");
  process.exit(1);
}
if (!SECRET) {
  console.error("telegram-poll: no TELEGRAM_WEBHOOK_SECRET_TOKEN — the channel won't accept updates.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

// null ⇒ no file (first run) — distinguish from a genuine offset 0.
async function loadOffset() {
  try {
    const { offset } = JSON.parse(await readFile(OFFSET_FILE, "utf8"));
    return typeof offset === "number" ? offset : null;
  } catch {
    return null;
  }
}

// First run: jump to the tail of the queue (last update_id + 1) to avoid replaying the
// install backlog. drop_pending already clears Telegram's queue — this is a belt over suspenders.
async function fastForwardOffset() {
  try {
    const data = await tg("getUpdates", { offset: -1, timeout: 0 });
    const list = data.ok ? data.result || [] : [];
    return list.length ? list[list.length - 1].update_id + 1 : 0;
  } catch (e) {
    log("fast-forward offset failed:", e.message);
    return 0;
  }
}

// Serialization key = eve continuation hook (telegram:<chatId>:<threadId>:):
// one chat (+ forum topic) — one session, deliver into it one at a time with a pause.
function chatKey(update) {
  const msg = update.message ?? update.callback_query?.message;
  const chatId = msg?.chat?.id;
  if (chatId === undefined) return null;
  const threadId = msg?.message_thread_id;
  return `${chatId}:${threadId ?? ""}`;
}
async function saveOffset(offset) {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(OFFSET_FILE, JSON.stringify({ offset }), { encoding: "utf8", mode: 0o600 });
    await chmod(OFFSET_FILE, 0o600);
  } catch (e) {
    log("offset save failed:", e.message);
  }
}

async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

// Deliver one update to the local eve (we mimic a webhook). Wait for 2xx — don't drop the update,
// even if the server is still coming up (backoff up to 15s).
async function deliver(update) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(ROUTE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": SECRET,
        },
        body: JSON.stringify(update),
      });
      if (res.ok) return;
      log(`deliver: eve replied ${res.status} (attempt ${attempt}) — retrying`);
    } catch (e) {
      log(`deliver: eve unavailable (${e.message}, attempt ${attempt}) — waiting for server`);
    }
    await sleep(Math.min(15000, 1000 * attempt));
  }
}

async function reply(chatId, text) {
  try {
    await tg("sendMessage", { chat_id: chatId, text });
  } catch (e) {
    log("reply failed:", e.message);
  }
}

async function sendWizard(chatId, view, messageId) {
  const body = { chat_id: chatId, text: view.text, ...(view.reply_markup ? { reply_markup: view.reply_markup } : {}) };
  try {
    if (messageId) await tg("editMessageText", { ...body, message_id: messageId });
    else await tg("sendMessage", body);
  } catch (e) {
    log("model wizard delivery failed:", e.message);
  }
}

const sc = (...args) =>
  new Promise((resolve) => execFile("systemctl", ["--user", ...args], (err) => resolve(!err)));

async function restartAgent() {
  return sc("restart", "iva.service");
}

async function waitAgentReadiness(timeoutMs = 60_000) {
  const client = new Client({ host: HOST });
  const healthy = async (deadline) => {
    while (Date.now() < deadline) {
      try {
        await Promise.race([
          client.health(),
          new Promise((_, reject) => setTimeout(() => reject(new Error("health timeout")), 3_000)),
        ]);
        return true;
      } catch {
        await sleep(500);
      }
    }
    return false;
  };
  if (!(await healthy(Date.now() + timeoutMs))) return false;
  await sleep(2_000);
  return healthy(Date.now() + 5_000);
}

async function freshEnvironment() {
  return { ...process.env, ...await readEnvValues(ENV_PATH) };
}

async function configuredProvider(provider, env) {
  const codexAuthenticated = existsSync(join(DATA_PATH, "codex-auth.json"));
  return providerAccessConfigured(provider, env, { codexAuthenticated });
}

const modelWizard = new ModelWizard({
  loadEnvironment: freshEnvironment,
  providerAvailable: configuredProvider,
  inventory: (provider, _role, env) => listConfiguredModels(provider, env),
  applySelection: (selection) => applyModelSelection({
    envPath: ENV_PATH,
    dataDir: DATA_PATH,
    selection,
    baseEnvironment: process.env,
    providerAvailable: configuredProvider,
    probe: ({ selection: candidate, env }) => candidate.role === "effort"
      ? true
      : runBoundedModelProbe({ root: ROOT, role: candidate.role, env }),
    restart: restartAgent,
    readiness: waitAgentReadiness,
  }),
});

// /new is an explicit owner reset. Use the same backend-neutral cancellation path as the CLI;
// the bridge stays alive while iva.service is stopped, so it can report the outcome.
function resetAgent() {
  return new Promise((resolve) =>
    execFile(NODE, [join(ROOT, "bin/iva.mjs"), "reset", "--yes"], (err) => resolve(!err)),
  );
}

// ── self-update (/update) ──────────────────────────────────────────────────
// git in ROOT. Fail loudly: treating a failed fetch/rev-parse as empty output can falsely
// report "latest version" and hide the only useful diagnostic from the owner.
function git(...args) {
  return new Promise((resolve, reject) =>
    execFile("git", ["-C", ROOT, ...args], { maxBuffer: 1 << 20 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || err.message || "git failed").toString().trim()));
      resolve((out || "").trim());
    }),
  );
}

function resolveDeploymentUpdateChannel() {
  return resolveUpdateChannel({
    dataDir: DATA_PATH,
    requireCheckout: true,
    runGit: (args) => {
      const result = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 10_000 });
      return {
        code: result.status ?? 1,
        out: String(result.stdout || "").trim(),
        err: String(result.stderr || "").trim(),
      };
    },
  }).channel;
}

// Run `iva update` in its OWN transient systemd scope, so it survives the restart of
// THIS bridge (restartServices restarts iva-telegram-poll too — a plain child would be
// killed with us). --collect GC's the unit after exit. A private opaque job lets the
// detached process edit the original Telegram message through the restart.
function launchSelfUpdate(jobId) {
  const args = [
    "--user", "--collect", `--unit=iva-self-update-${jobId}`,
    `--working-directory=${ROOT}`,
    `--setenv=PATH=${process.env.PATH || ""}`,
    NODE, join(ROOT, "bin/iva.mjs"), "update", `--telegram-job=${jobId}`,
  ];
  return new Promise((resolve) =>
    execFile("systemd-run", args, (err, out, e) => resolve({ ok: !err, msg: (e || out || "").toString().trim() })),
  );
}

async function handleUpdateCheck(chatId) {
  await reply(chatId, "Checking for updates…");
  let info;
  try {
    info = await checkDeploymentUpdate(git, resolveDeploymentUpdateChannel());
  } catch (e) {
    await reply(chatId, "Couldn't check for updates: " + e.message);
    return;
  }
  if (!info.hasUpdate) {
    await reply(chatId, `You're on the latest version (v${info.localVer ?? "?"}, ${info.local.slice(0, 7)}).`);
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: renderUpdateOffer(info, { locale: updateLocale(process.env) }),
    reply_markup: updateOfferKeyboard({ locale: updateLocale(process.env) }),
  });
}

async function handleUpdateView(chatId, messageId) {
  const locale = updateLocale(process.env);
  let info;
  try {
    info = await checkDeploymentUpdate(git, resolveDeploymentUpdateChannel());
    if (!info.hasUpdate) {
      await tg("editMessageText", {
        chat_id: chatId, message_id: messageId,
        text: locale === "ru"
          ? `Уже установлена последняя target-версия (${info.local.slice(0, 7)}).`
          : `You're already on the latest target (${info.local.slice(0, 7)}).`,
      });
      return;
    }
    let changes = [];
    try {
      changes = normalizeUpdateChanges(await git(
        "log", "--format=%h %s", "--max-count=5", `HEAD..${info.channel}`,
      ));
    } catch (error) {
      log("update change list unavailable:", error.message);
    }
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: renderUpdateOffer(info, { locale, detailed: true, changes }),
      reply_markup: updateOfferKeyboard({ locale }),
    });
  } catch (error) {
    await tg("editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: locale === "ru"
        ? "Не удалось посмотреть обновление. Ничего не установлено; повтори через /update."
        : "Couldn't inspect the update. Nothing was installed; retry with /update.",
    });
  }
}

// Inline-button taps for the /update flow. Handled by the bridge; never delivered to eve.
async function handleUpdateCallback(cq) {
  const from = String(cq.from?.id ?? "");
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  try { await tg("answerCallbackQuery", { callback_query_id: cq.id }); } // clear the button spinner
  catch (error) { log("update callback acknowledgement failed:", error.message); }
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true; // swallow untrusted taps
  const locale = updateLocale(process.env);
  const action = parseUpdateAction(cq.data);
  if (!action) {
    await tg("editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: locale === "ru" ? "Действие обновления недействительно или устарело." : "Update action is invalid or expired.",
    });
    return true;
  }
  if (action === "skip" || action === "later") {
    await tg("editMessageText", {
      chat_id: chatId, message_id: messageId,
      text: locale === "ru" ? "Обновление отложено. Новый target commit будет предложен отдельно." : "Update postponed. A different target commit may be offered later.",
    });
    return true;
  }
  if (action === "view") {
    await handleUpdateView(chatId, messageId);
    return true;
  }
  // Persist only an opaque run id in argv. The private job file carries the Telegram
  // target so the detached updater can keep editing this message while the bridge restarts.
  let updateJob;
  try {
    updateJob = createTelegramUpdateJob(DATA_PATH, { chatId, messageId, locale });
  } catch (error) {
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: `Couldn't prepare the update: ${error.message}` });
    return true;
  }
  try {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: renderUpdateProgress("configuration", locale),
    });
  } catch (error) {
    log("initial update progress edit failed:", error.message);
  }
  const r = await launchSelfUpdate(updateJob.id);
  if (!r.ok) {
    removeTelegramUpdateJob(updateJob.path);
    try {
      await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "Couldn't start the update: " + r.msg });
    } catch (error) {
      log("update launch failure edit failed:", error.message);
    }
  }
  return true;
}

// Control commands are handled by the BRIDGE (out-of-band) — they work even if the agent is stuck.
// Trusted IDs only. Returns true if the command was handled (we do NOT deliver it to eve).
async function handleControl(update) {
  // /update inline-button taps (Update / Skip) — bridge-owned, not an eve HITL callback.
  const cq = update.callback_query;
  if (cq && typeof cq.data === "string" && cq.data.startsWith("iva_update:")) {
    return handleUpdateCallback(cq);
  }
  if (cq && typeof cq.data === "string" && cq.data.startsWith("iva_model:")) {
    const from = String(cq.from?.id ?? "");
    await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Обрабатываю…" });
    if (ALLOWED.size === 0 || !ALLOWED.has(from)) return true;
    const chatId = cq.message?.chat?.id;
    const view = await modelWizard.handle(cq.data, { userId: from, chatId });
    await sendWizard(chatId, view, cq.message?.message_id);
    return true;
  }
  const msg = update.message;
  const text = (msg?.text || "").trim();
  if (!text.startsWith("/")) return false;
  const cmd = text.split(/\s+/)[0].replace(/@\w+$/, "").toLowerCase();
  if (!CONTROL_COMMANDS.includes(cmd)) return false;
  const from = String(msg?.from?.id ?? "");
  if (ALLOWED.size === 0 || !ALLOWED.has(from)) return false; // untrusted — let eve drop it
  const chatId = msg?.chat?.id;
  if (cmd === "/help") {
    await reply(chatId, HELP);
    return true;
  }
  if (cmd === "/model" || cmd === "/think") {
    const view = await modelWizard.open(cmd === "/think" ? "think" : "model", { userId: from, chatId });
    await sendWizard(chatId, view);
    return true;
  }
  // /usage — token spend from data/usage.jsonl. Out-of-band and FREE (we don't call the model).
  if (cmd === "/usage") {
    const arg = text.split(/\s+/).slice(1).join(" ");
    try {
      const agg = summarize(readEntries(), { window: parseWindow(arg), now: Date.now(), tz: process.env.ASSISTANT_TIMEZONE });
      await reply(chatId, formatUsageReport(agg));
    } catch (e) {
      await reply(chatId, "Couldn't read the usage log: " + e.message);
    }
    return true;
  }
  if (cmd === "/reminders") {
    try {
      const items = (await loadReminders()).filter((r) => ["pending", "sending", "delivery_unknown"].includes(r.status));
      await reply(chatId, items.length ? items.map((r) => formatReminder(r)).join("\n") : "No active reminders.");
    } catch (e) {
      await reply(chatId, "Couldn't read reminders: " + e.message);
    }
    return true;
  }
  // /update — check upstream; if newer, offer inline Update/Skip buttons. Out-of-band.
  if (cmd === "/update") {
    await handleUpdateCheck(chatId);
    return true;
  }
  const isRestart = cmd === "/restart";
  await reply(chatId, isRestart ? "Restarting the agent without deleting its state…" : "Starting over — cancelling active sessions…");
  const ok = isRestart ? await restartAgent() : await resetAgent();
  await reply(chatId, ok ? "Done — go ahead." : "Couldn't complete recovery. Run `iva status` on the server.");
  return true;
}

async function main() {
  log(`telegram-poll start → ${ROUTE}`);
  // First run (no offset file) — drop the accumulated install backlog (drop_pending=true),
  // so old messages don't replay in a batch → parallel sessions on one chat (HookConflict).
  // On subsequent starts we do NOT drop the backlog (don't lose messages that arrived while the bridge was down).
  const firstRun = !existsSync(OFFSET_FILE);
  const dw = await tg("deleteWebhook", { drop_pending_updates: firstRun });
  log("deleteWebhook:", dw.ok ? `ok (drop_pending=${firstRun})` : dw.description);
  const commandMenu = CONTROL_COMMANDS.map((command) => ({
    command: command.slice(1),
    description: {
      "/help": "Show commands", "/usage": "Token usage", "/reminders": "Active reminders",
      "/restart": "Restart agent", "/new": "Reset conversation", "/clear": "Reset conversation",
      "/compact": "Compact conversation", "/update": "Update Iva", "/model": "Text and vision models",
      "/think": "Text reasoning depth",
    }[command] || "Iva command",
  }));
  const menu = await tg("setMyCommands", { commands: commandMenu });
  log("setMyCommands:", menu.ok ? "ok" : menu.description);

  let offset = await loadOffset();
  if (offset === null) {
    offset = await fastForwardOffset();
    log("first run — offset past the tail of the queue:", offset);
    await saveOffset(offset);
  } else {
    log("starting offset:", offset);
  }

  // Time of the last delivery per chat key — for the SETTLE_MS pause between a chat's updates.
  const lastDeliverAt = new Map();

  for (;;) {
    let data;
    try {
      data = await tg("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message", "callback_query"],
      });
    } catch (e) {
      log("getUpdates network:", e.message);
      await sleep(3000);
      continue;
    }
    if (!data.ok) {
      log("getUpdates:", data.description);
      // 409/conflict — a webhook is left somewhere; remove it and try again.
      if (/409|conflict|webhook/i.test(data.description || "")) {
        await tg("deleteWebhook", { drop_pending_updates: false });
      }
      await sleep(3000);
      continue;
    }
    for (const update of data.result || []) {
      // Control commands (/restart, /help, /new) — the bridge handles them itself, doesn't send to eve.
      if (await handleControl(update)) {
        offset = update.update_id + 1;
        await saveOffset(offset);
        continue;
      }
      const key = chatKey(update);
      // Don't deliver the next update of the same chat until eve has parked the previous turn
      // (pause measured from the last delivery to this chat) — otherwise a burst → HookConflict.
      if (key !== null && SETTLE_MS > 0) {
        const prev = lastDeliverAt.get(key);
        if (prev !== undefined) {
          const wait = SETTLE_MS - (Date.now() - prev);
          if (wait > 0) await sleep(wait);
        }
      }
      await deliver(update); // wait for successful delivery — ordered and lossless
      if (key !== null) lastDeliverAt.set(key, Date.now());
      offset = update.update_id + 1;
      await saveOffset(offset);
    }
  }
}

main().catch((e) => {
  console.error("telegram-poll fatal:", e);
  process.exit(1);
});
