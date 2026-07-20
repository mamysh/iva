import assert from "node:assert/strict";

import { ModelWizard, parseModelCallback } from "./model-wizard.mjs";
import { resolveModelRoles } from "./model-profile.mjs";

function button(view, label) {
  const found = view.reply_markup?.inline_keyboard.flat().find((item) => item.text === label);
  assert.ok(found, `button not found: ${label}\n${JSON.stringify(view)}`);
  return found.callback_data;
}

let serial = 0;
let now = 1_000;
let env = {
  MODEL_PROVIDER: "codex",
  CODEX_MODEL: "gpt-5.5",
  THINKING_EFFORT: "medium",
  VISION_PROVIDER: "ollama",
  OLLAMA_API_KEY: "secret-must-not-leak",
  OLLAMA_MODEL: "deepseek-v4-pro",
  OLLAMA_VISION_MODEL: "minimax-m3",
};
const applied = [];
const wizard = new ModelWizard({
  loadEnvironment: async () => ({ ...env }),
  providerAvailable: async (provider, values) => provider === "codex" || (provider === "ollama" && Boolean(values.OLLAMA_API_KEY)),
  applySelection: async (selection) => {
    applied.push(selection);
    if (selection.role === "text") {
      env.MODEL_PROVIDER = selection.provider;
      env[selection.provider === "codex" ? "CODEX_MODEL" : "OLLAMA_MODEL"] = selection.model;
    } else if (selection.role === "vision") {
      env.VISION_PROVIDER = selection.provider;
      env[selection.provider === "codex" ? "CODEX_VISION_MODEL" : "OLLAMA_VISION_MODEL"] = selection.model;
    } else {
      env.THINKING_EFFORT = selection.effort;
    }
    return { after: resolveModelRoles(env) };
  },
  inventory: async (provider, role) => role === "text" && provider === "codex" ? ["gpt-5.5", "gpt-live-extra"] : ["tampered-vision"],
  randomId: () => `id${String(++serial).padStart(8, "0")}`,
  now: () => now,
  ttlMs: 100,
});

const actor = { userId: "42", chatId: "900" };
let view = await wizard.open("model", actor);
assert.match(view.text, /Текст: OpenAI .*gpt-5\.5/);
assert.match(view.text, /Зрение: Ollama Cloud · minimax-m3/);
for (const item of view.reply_markup.inline_keyboard.flat()) {
  assert.ok(parseModelCallback(item.callback_data));
  assert.doesNotMatch(item.callback_data, /codex|ollama|gpt|mini|max|secret/i, "callback must be opaque");
  assert.ok(item.callback_data.length <= 64);
}

const textAction = button(view, "💬 Текст");
assert.equal((await wizard.handle(textAction, { userId: "7", chatId: "900" })).status, "forbidden");
assert.equal((await wizard.handle("iva_model:id00000001:forged", actor)).status, "invalid");
view = await wizard.handle(textAction, actor);
assert.match(view.text, /выберите уже настроенного провайдера/);
assert.ok(button(view, "OpenAI (ChatGPT subscription)"));
assert.ok(button(view, "Ollama Cloud"));
assert.doesNotMatch(JSON.stringify(view), /OpenRouter|OpenCode/);

view = await wizard.handle(button(view, "Ollama Cloud"), actor);
assert.match(view.text, /Текст · Ollama Cloud/);
view = await wizard.handle(button(view, "✓ deepseek-v4-pro"), actor);
assert.match(view.text, /Зрение: без изменений · ollama\/minimax-m3/);
view = await wizard.handle(button(view, "Проверить и применить"), actor);
assert.equal(applied.at(-1).role, "text");
assert.equal(applied.at(-1).provider, "ollama");
assert.match(view.text, /✅ Применено/);

// Unsupported provider must not pretend that /think has an effect.
let unsupported = await wizard.open("think", actor);
assert.match(unsupported.text, /не поддерживается/);
assert.doesNotMatch(JSON.stringify(unsupported), /Минимальная/);

// Restore Codex for the effort flow.
env.MODEL_PROVIDER = "codex";
let think = await wizard.open("think", actor);
assert.match(think.text, /Глубина рассуждения: medium/);
think = await wizard.handle(button(think, "Высокая"), actor);
assert.match(think.text, /Глубина: medium → high/);
think = await wizard.handle(button(think, "Проверить и применить"), actor);
assert.equal(applied.at(-1).role, "effort");
assert.equal(env.THINKING_EFFORT, "high");

// Refresh may expand text inventory, but uncurated vision IDs remain hidden.
let refreshed = await wizard.open("model", actor);
refreshed = await wizard.handle(button(refreshed, "🔄 Обновить список"), actor);
assert.match(refreshed.text, /Списки доступных моделей обновлены/);
refreshed = await wizard.handle(button(refreshed, "👁 Зрение"), actor);
refreshed = await wizard.handle(button(refreshed, "Ollama Cloud"), actor);
assert.doesNotMatch(JSON.stringify(refreshed), /tampered-vision/);

wizard.applySelection = async () => { throw new Error("ENOENT /private/iva/.env secret-must-not-leak"); };
let failedApply = await wizard.open("model", actor);
failedApply = await wizard.handle(button(failedApply, "💬 Текст"), actor);
failedApply = await wizard.handle(button(failedApply, "OpenAI (ChatGPT subscription)"), actor);
failedApply = await wizard.handle(button(failedApply, "✓ gpt-5.5"), actor);
failedApply = await wizard.handle(button(failedApply, "Проверить и применить"), actor);
assert.match(failedApply.text, /отклонено безопасной проверкой/);
assert.doesNotMatch(failedApply.text, /private|\.env|secret/i);

let expiring = await wizard.open("model", actor);
const expiringAction = button(expiring, "Закрыть");
now += 101;
assert.equal((await wizard.handle(expiringAction, actor)).status, "expired");
assert.equal((await wizard.handle("iva_model:not-valid", actor)).status, "invalid");

console.log("model wizard checks passed: role UI, opaque owner-bound callbacks, effort and TTL");
