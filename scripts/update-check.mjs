#!/usr/bin/env node
import { execFile, spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveUpdateChannel } from "./lib/update-channel.mjs";
import { acquireUpdateLock, releaseUpdateLock } from "./lib/update-lock.mjs";
import {
  readUpdateNotificationState,
  recordUpdateCheck,
  renderUpdateOffer,
  shouldNotifyUpdate,
  updateCheckEnabled,
  updateLocale,
  updateOfferKeyboard,
} from "./lib/update-notification.mjs";
import { checkDeploymentUpdate } from "./lib/telegram-update.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const configuredDataDir = process.env.ASSISTANT_DATA_DIR || "data";
const DATA_DIR = isAbsolute(configuredDataDir) ? configuredDataDir : join(ROOT, configuredDataDir);

function git(...args) {
  return new Promise((resolve, reject) => execFile(
    "git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 20, timeout: 30_000 },
    (error, stdout) => error ? reject(new Error("update channel inspection failed")) : resolve(String(stdout || "").trim()),
  ));
}

function deploymentChannel(dataDir = DATA_DIR) {
  return resolveUpdateChannel({
    dataDir,
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

function ownerChat(env = process.env) {
  return String(
    env.TELEGRAM_DIGEST_CHAT_ID
    || String(env.TELEGRAM_ALLOWED_USER_IDS || "").split(/[,\s]+/).find(Boolean)
    || "",
  ).trim();
}

async function sendTelegramOffer(info, env = process.env) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = ownerChat(env);
  if (!token || !chatId) throw new Error("Telegram owner notification is not configured");
  const locale = updateLocale(env);
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: renderUpdateOffer(info, { locale }),
      reply_markup: updateOfferKeyboard({ locale, includeView: true }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error("Telegram owner notification failed");
}

export async function runUpdateCheck({
  env = process.env,
  dataDir = DATA_DIR,
  acquireLock = acquireUpdateLock,
  releaseLock = releaseUpdateLock,
  inspect = () => checkDeploymentUpdate(git, deploymentChannel(dataDir)),
  readState = readUpdateNotificationState,
  recordCheck = recordUpdateCheck,
  sendOffer = sendTelegramOffer,
} = {}) {
  if (!updateCheckEnabled(env)) return { outcome: "disabled" };
  const lock = acquireLock(dataDir, { source: "notification" });
  if (!lock.ok) return { outcome: "busy" };
  try {
    const info = await inspect();
    const state = readState(dataDir);
    if (!shouldNotifyUpdate(state, info)) {
      recordCheck(dataDir, info);
      return { outcome: info.hasUpdate ? "deduplicated" : "current", targetCommit: info.remote };
    }
    await sendOffer(info, env);
    recordCheck(dataDir, info, { notified: true });
    return { outcome: "notified", targetCommit: info.remote };
  } finally {
    releaseLock(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runUpdateCheck();
    console.log(`update-check: ${result.outcome}${result.targetCommit ? ` (${result.targetCommit.slice(0, 7)})` : ""}`);
  } catch {
    // A network, remote or Telegram outage must never affect agent/polling readiness. The timer retries
    // on its next schedule and intentionally leaves lastNotifiedCommit unchanged after failed delivery.
    console.warn("update-check: unavailable; no update was installed and the next schedule will retry");
  }
}
