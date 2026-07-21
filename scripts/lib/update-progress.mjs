import { randomUUID } from "node:crypto";
import {
  chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const UPDATE_PHASES = [
  "configuration",
  "target",
  "dependencies",
  "verification",
  "storage",
  "activation",
  "readiness",
];

const COPY = {
  en: {
    phases: {
      configuration: "Checking configuration",
      target: "Getting the target version",
      dependencies: "Installing dependencies",
      verification: "Running tests and build",
      storage: "Checking the storage profile",
      activation: "Activating the version",
      readiness: "Checking readiness",
    },
    updated: "✅ Iva updated",
    current: "✅ Iva is already up to date",
    blocked: "⏸️ Another update is already running",
    rolledBack: "↩️ Update rolled back",
    previousActive: "The previous version is active.",
    retry: "Retry: /update",
  },
  ru: {
    phases: {
      configuration: "Проверяю конфигурацию",
      target: "Получаю целевую версию",
      dependencies: "Устанавливаю зависимости",
      verification: "Запускаю тесты и сборку",
      storage: "Проверяю storage profile",
      activation: "Активирую версию",
      readiness: "Проверяю readiness",
    },
    updated: "✅ Iva обновлена",
    current: "✅ Iva уже на актуальной версии",
    blocked: "⏸️ Другое обновление уже выполняется",
    rolledBack: "↩️ Обновление отменено с откатом",
    previousActive: "Предыдущая версия активна.",
    retry: "Повторить: /update",
  },
};

function localeOf(value) {
  return value === "ru" ? "ru" : "en";
}

export function renderUpdateProgress(activePhase, locale = "en") {
  const lang = localeOf(locale);
  const activeIndex = Math.max(0, UPDATE_PHASES.indexOf(activePhase));
  return UPDATE_PHASES.map((phase, index) => {
    const marker = index < activeIndex ? "✓" : index === activeIndex ? "◇" : "·";
    return `${marker} ${COPY[lang].phases[phase]}`;
  }).join("\n");
}

function shortCommit(value) {
  return typeof value === "string" && value ? value.slice(0, 7) : null;
}

export function renderUpdateResult(result, locale = "en") {
  const copy = COPY[localeOf(locale)];
  const before = shortCommit(result?.currentCommit);
  const after = shortCommit(result?.targetCommit);
  if (result?.outcome === "updated") {
    return [copy.updated, before && after ? `${before} → ${after}` : null, "", UPDATE_PHASES.map((phase) => `✓ ${copy.phases[phase]}`).join("\n")]
      .filter((line) => line !== null).join("\n");
  }
  if (result?.outcome === "current") {
    return `${copy.current}${before ? ` (${before})` : ""}`;
  }
  if (result?.outcome === "blocked") return `${copy.blocked}\n\n${copy.retry}`;
  return `${copy.rolledBack}${result?.reason ? `\n${result.reason}` : ""}\n\n${copy.previousActive}\n${copy.retry}`;
}

function assertTelegramJob(job) {
  const chatId = String(job?.chatId ?? "");
  const messageId = Number(job?.messageId);
  if (!/^-?\d+$/.test(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new Error("Telegram update target is invalid");
  }
  return { schemaVersion: 1, chatId, messageId, locale: localeOf(job.locale) };
}

export function createTelegramUpdateJob(dataDir, job) {
  const value = assertTelegramJob(job);
  const id = randomUUID();
  const directory = join(dataDir, "update-jobs");
  const path = join(directory, `${id}.json`);
  const temporary = `${path}.tmp-${process.pid}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return { id, path, job: value };
}

export function loadTelegramUpdateJob(dataDir, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) return null;
  const path = join(dataDir, "update-jobs", `${id}.json`);
  try {
    return { path, job: assertTelegramJob(JSON.parse(readFileSync(path, "utf8"))) };
  } catch {
    return null;
  }
}

export function removeTelegramUpdateJob(path) {
  if (!path) return;
  rmSync(path, { force: true });
  try { rmSync(dirname(path)); } catch {}
}

export function createTelegramUpdateReporter({
  token,
  job,
  fetchImpl = fetch,
  sleepImpl,
  requestTimeoutMs = 5000,
} = {}) {
  if (!token || !job) return null;
  const target = assertTelegramJob(job);
  const wait = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const api = `https://api.telegram.org/bot${token}`;
  let lastText = null;
  let fallbackSent = false;
  let phaseEditsDisabled = false;
  const timeoutMs = Math.max(1, Math.min(30_000, Number(requestTimeoutMs) || 5000));

  async function call(method, body) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetchImpl(`${api}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await response.json().catch(() => ({ ok: false }));
        if (response.ok && data.ok) return true;
        if (attempt === 3 || (response.status !== 429 && response.status < 500)) return false;
        await wait(Math.min(5000, Math.max(250, Number(data.parameters?.retry_after || 1) * 1000)));
      } catch {
        if (attempt === 3) return false;
        await wait(250 * attempt);
      }
    }
    return false;
  }

  async function edit(text) {
    if (text === lastText) return true;
    const ok = await call("editMessageText", {
      chat_id: target.chatId,
      message_id: target.messageId,
      text,
    });
    if (ok) lastText = text;
    return ok;
  }

  return {
    async phase(phase) {
      if (!UPDATE_PHASES.includes(phase) || phaseEditsDisabled) return;
      if (!(await edit(renderUpdateProgress(phase, target.locale)))) phaseEditsDisabled = true;
    },
    async complete(result) {
      const text = renderUpdateResult(result, target.locale);
      if (await edit(text)) return;
      if (fallbackSent) return;
      fallbackSent = true;
      await call("sendMessage", { chat_id: target.chatId, text });
    },
  };
}
