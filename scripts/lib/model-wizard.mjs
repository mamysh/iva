import { MODEL_CATALOG, MODEL_PROVIDERS, THINKING_EFFORTS } from "./model-catalog.mjs";
import { resolveModelRoles } from "./model-profile.mjs";

const CALLBACK_PREFIX = "iva_model:";
const SAFE_MODEL_ID = /^[A-Za-z0-9._:/@+-]{1,180}$/;
const EFFORT_LABELS = { minimal: "Минимальная", low: "Низкая", medium: "Средняя", high: "Высокая" };

function uniqueModels(values) {
  return [...new Set(values.map(String).map((value) => value.trim()).filter((value) => SAFE_MODEL_ID.test(value)))].slice(0, 24);
}

function roleName(role) {
  return role === "text" ? "Текст" : "Зрение";
}

function safeApplyError(error) {
  const message = String(error?.message || "");
  if (/already running/.test(message)) return "другое изменение конфигурации ещё выполняется";
  if (/not configured/.test(message)) return "выбранный провайдер больше не настроен";
  if (/capability probe failed/.test(message)) return "модель не прошла проверку возможностей";
  if (/previous configuration restored on disk but service recovery failed/.test(message)) {
    return "прежняя конфигурация возвращена на диск, но сервис не восстановился; запустите iva doctor";
  }
  if (/previous configuration restored/.test(message)) return "проверка readiness не прошла; прежняя конфигурация восстановлена";
  if (/restart failed|did not become ready/.test(message)) return "агент не перезапустился с новой конфигурацией";
  return "изменение отклонено безопасной проверкой";
}

export function parseModelCallback(data) {
  const match = /^iva_model:([A-Za-z0-9_-]{8,24}):([A-Za-z0-9_-]{4,16})$/.exec(String(data || ""));
  return match ? { sessionId: match[1], actionId: match[2] } : null;
}

export class ModelWizard {
  constructor({
    loadEnvironment,
    providerAvailable,
    applySelection,
    inventory = async () => [],
    now = Date.now,
    randomId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    ttlMs = 5 * 60_000,
  }) {
    this.loadEnvironment = loadEnvironment;
    this.providerAvailable = providerAvailable;
    this.applySelection = applySelection;
    this.inventory = inventory;
    this.now = now;
    this.randomId = randomId;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  async open(kind, { userId, chatId }) {
    this.prune();
    const session = {
      id: this.randomId(),
      userId: String(userId),
      chatId: String(chatId),
      expiresAt: this.now() + this.ttlMs,
      actions: new Map(),
      inventory: { text: {}, vision: {} },
      pending: null,
    };
    this.sessions.set(session.id, session);
    return kind === "think" ? this.renderEffort(session) : this.renderRoot(session);
  }

  async handle(data, { userId, chatId }) {
    this.prune();
    const parsed = parseModelCallback(data);
    if (!parsed) return { status: "invalid", text: "Действие недействительно." };
    const session = this.sessions.get(parsed.sessionId);
    if (!session) return { status: "expired", text: "Меню устарело. Откройте /model ещё раз." };
    if (session.userId !== String(userId) || session.chatId !== String(chatId)) {
      return { status: "forbidden", text: "Это меню принадлежит другому чату." };
    }
    const action = session.actions.get(parsed.actionId);
    if (!action) return { status: "invalid", text: "Действие уже использовано или подменено." };
    session.actions.clear();
    session.expiresAt = this.now() + this.ttlMs;

    if (action.type === "close") {
      this.sessions.delete(session.id);
      return { status: "close", text: "Настройка моделей закрыта." };
    }
    if (action.type === "root") return this.renderRoot(session);
    if (action.type === "role") return this.renderProviders(session, action.role);
    if (action.type === "effort-screen") return this.renderEffort(session);
    if (action.type === "provider") return this.renderModels(session, action.role, action.provider);
    if (action.type === "model") {
      session.pending = { role: action.role, provider: action.provider, model: action.model };
      return this.renderConfirmation(session);
    }
    if (action.type === "effort") {
      session.pending = { role: "effort", effort: action.effort };
      return this.renderConfirmation(session);
    }
    if (action.type === "refresh") {
      const notice = await this.refreshInventory(session);
      return this.renderRoot(session, notice);
    }
    if (action.type === "apply") {
      try {
        const result = await this.applySelection(session.pending);
        session.pending = null;
        const changed = result.after;
        return this.renderRoot(
          session,
          `✅ Применено. Текст: ${changed.text.provider}/${changed.text.model}; зрение: ${changed.vision.provider}/${changed.vision.model}.`,
        );
      } catch (error) {
        return this.renderConfirmation(session, `❌ Не применено: ${safeApplyError(error)}`);
      }
    }
    return { status: "invalid", text: "Неизвестное действие." };
  }

  prune() {
    const cutoff = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= cutoff) this.sessions.delete(id);
  }

  button(session, text, action) {
    let actionId;
    do actionId = this.randomId().slice(0, 10); while (session.actions.has(actionId));
    session.actions.set(actionId, action);
    return { text, callback_data: `${CALLBACK_PREFIX}${session.id}:${actionId}` };
  }

  async environment() {
    return this.loadEnvironment();
  }

  async availableProviders(env) {
    const values = [];
    for (const provider of MODEL_PROVIDERS) if (await this.providerAvailable(provider, env)) values.push(provider);
    return values;
  }

  view(session, text, rows) {
    return { status: "view", text, reply_markup: { inline_keyboard: rows } };
  }

  async renderRoot(session, notice = "") {
    session.actions.clear();
    const roles = resolveModelRoles(await this.environment());
    const effort = roles.effort.effective || (roles.effort.supported.length ? "не задана" : "не поддерживается");
    const text = [
      "Модели Iva",
      "",
      `Текст: ${MODEL_CATALOG[roles.text.provider].label} · ${roles.text.model}`,
      `Зрение: ${MODEL_CATALOG[roles.vision.provider].label} · ${roles.vision.model}`,
      `Глубина: ${effort}`,
      notice ? `\n${notice}` : "",
    ].filter(Boolean).join("\n");
    return this.view(session, text, [
      [this.button(session, "💬 Текст", { type: "role", role: "text" }), this.button(session, "👁 Зрение", { type: "role", role: "vision" })],
      [this.button(session, "🧠 Глубина", { type: "effort-screen" }), this.button(session, "🔄 Обновить список", { type: "refresh" })],
      [this.button(session, "Закрыть", { type: "close" })],
    ]);
  }

  async renderProviders(session, role) {
    session.actions.clear();
    const providers = await this.availableProviders(await this.environment());
    const rows = providers.map((provider) => [this.button(session, MODEL_CATALOG[provider].label, { type: "provider", role, provider })]);
    rows.push([this.button(session, "← Назад", { type: "root" }), this.button(session, "Закрыть", { type: "close" })]);
    return this.view(session, `${roleName(role)}: выберите уже настроенного провайдера.`, rows);
  }

  async renderModels(session, role, provider) {
    session.actions.clear();
    const env = await this.environment();
    if (!(await this.providerAvailable(provider, env))) return this.renderRoot(session, "Провайдер больше не настроен.");
    const profile = resolveModelRoles(env).profiles[provider];
    const catalog = MODEL_CATALOG[provider];
    const current = role === "text" ? profile.textModel : profile.visionModel;
    const fallback = role === "text" ? catalog.textCandidates : catalog.visionCandidates;
    const models = uniqueModels([current, ...fallback, ...(session.inventory[role][provider] || [])]);
    const rows = models.map((model) => [this.button(session, `${model === current ? "✓ " : ""}${model}`, { type: "model", role, provider, model })]);
    rows.push([this.button(session, "← Провайдеры", { type: "role", role }), this.button(session, "Закрыть", { type: "close" })]);
    return this.view(session, `${roleName(role)} · ${catalog.label}\nВыберите модель:`, rows);
  }

  async renderEffort(session) {
    session.actions.clear();
    const roles = resolveModelRoles(await this.environment());
    if (!roles.effort.supported.length) {
      return this.view(session, `Глубина рассуждения не поддерживается текстовым провайдером ${MODEL_CATALOG[roles.text.provider].label}.`, [
        [this.button(session, "← К моделям", { type: "root" }), this.button(session, "Закрыть", { type: "close" })],
      ]);
    }
    const rows = [];
    for (let index = 0; index < THINKING_EFFORTS.length; index += 2) {
      rows.push(THINKING_EFFORTS.slice(index, index + 2).map((effort) => this.button(
        session,
        `${EFFORT_LABELS[effort]}${roles.effort.effective === effort ? " ✓" : ""}`,
        { type: "effort", effort },
      )));
    }
    rows.push([this.button(session, "← К моделям", { type: "root" }), this.button(session, "Закрыть", { type: "close" })]);
    return this.view(session, `Глубина рассуждения: ${roles.effort.effective || "не задана"}`, rows);
  }

  async renderConfirmation(session, error = "") {
    session.actions.clear();
    const before = resolveModelRoles(await this.environment());
    const pending = session.pending;
    if (!pending) return this.renderRoot(session);
    let lines;
    if (pending.role === "text") {
      const nextEffort = MODEL_CATALOG[pending.provider].effort.length
        ? (before.effort.requested || "не задана")
        : "не поддерживается";
      lines = [
        `Текст: ${before.text.provider}/${before.text.model} → ${pending.provider}/${pending.model}`,
        `Зрение: без изменений · ${before.vision.provider}/${before.vision.model}`,
        `Глубина: ${before.effort.effective || "не задана"} → ${nextEffort}`,
      ];
    } else if (pending.role === "vision") {
      lines = [
        `Текст: без изменений · ${before.text.provider}/${before.text.model}`,
        `Зрение: ${before.vision.provider}/${before.vision.model} → ${pending.provider}/${pending.model}`,
        `Глубина: без изменений · ${before.effort.effective || "не задана"}`,
      ];
    } else {
      lines = [
        `Текст: без изменений · ${before.text.provider}/${before.text.model}`,
        `Зрение: без изменений · ${before.vision.provider}/${before.vision.model}`,
        `Глубина: ${before.effort.effective || "не задана"} → ${pending.effort}`,
      ];
    }
    if (error) lines.push("", error);
    lines.unshift("Проверка изменения");
    return this.view(session, lines.join("\n"), [
      [this.button(session, "Проверить и применить", { type: "apply" })],
      [this.button(session, "← Назад", pending.role === "effort" ? { type: "effort-screen" } : { type: "provider", role: pending.role, provider: pending.provider }), this.button(session, "Отмена", { type: "close" })],
    ]);
  }

  async refreshInventory(session) {
    const env = await this.environment();
    const providers = await this.availableProviders(env);
    let refreshed = 0;
    for (const provider of providers) {
      try {
        const models = uniqueModels(await this.inventory(provider, "text", env));
        session.inventory.text[provider] = models;
        session.inventory.vision[provider] = models.filter((model) => MODEL_CATALOG[provider].visionCandidates.includes(model));
        refreshed += 1;
      } catch {
        /* A provider inventory is optional; retain the curated fallback without exposing errors/secrets. */
      }
    }
    return refreshed ? "Списки доступных моделей обновлены." : "Live-списки недоступны; показан безопасный локальный каталог.";
  }
}
