// Отказы write_card, которые модель повторяет подряд (трейсы c1 и пользователя, 09.2026):
// SUPERSEDE без нынешней истины, history_entry при UPDATE, UPDATE/SUPERSEDE несуществующей
// карточки, заголовки и ## Related в body, чужой status. Каждый отказ обязан назвать поле,
// сказать, что пришло и что ждали, и закончиться вызовом-образцом («Example: {…}» или
// «Пример: {…}»), который разбирается как JSON и исправляет ровно этот случай.
// Запуск: node --test scripts/write-card-refusals.test.ts

import "./lib/ts-esm-hooks.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const VAULT = mkdtempSync(join(tmpdir(), "iva-card-refusals-"));
process.env.ASSISTANT_VAULT_DIR = VAULT;
process.env.ASSISTANT_TIMEZONE = "UTC";
mkdirSync(join(VAULT, "cards", "notes"), { recursive: true });
cpSync(join(REPO, "vault-template", "schema.json"), join(VAULT, "schema.json"));
writeFileSync(join(VAULT, "cards", "notes", "hub.md"), "цель ссылки\n");
process.on("exit", () => rmSync(VAULT, { recursive: true, force: true }));

const writeCard = (
  (await import(
    join(REPO, "agent", "tools", "write_card.ts")
  )) as typeof import("../agent/tools/write_card.ts")
).default;
type Input = Parameters<typeof writeCard.execute>[0];
type Result = { ok: boolean; error: string; action: string };
const schema = writeCard.inputSchema as unknown as {
  parse: (value: unknown) => Input;
};
const tool = writeCard as unknown as {
  execute: (input: Input) => Promise<Result>;
};
const call = (args: Record<string, unknown>) =>
  tool.execute(schema.parse(args));

/** Образец в конце текста отказа: разбирается как JSON, иначе модель его не повторит. */
function example(error: string): Record<string, unknown> {
  const at = Math.max(
    error.lastIndexOf("Example: "),
    error.lastIndexOf("Пример: "),
  );
  assert.notEqual(at, -1, `no example call in: ${error}`);
  const json = error.slice(error.indexOf(": ", at) + 2);
  return JSON.parse(json) as Record<string, unknown>;
}

let serial = 0;
function card(body: string): Record<string, unknown> {
  serial += 1;
  return {
    type: "note",
    title: `Отказ ${String(serial)}`,
    description: "карточка для проверки текста отказа",
    tags: ["refusal"],
    body,
  };
}

void test("SUPERSEDE that misses the Compiled Truth shows the truth and a passing history_entry", async () => {
  const base = card("Владелец Кэрол. Договор до марта.");
  assert.equal((await call({ ...base, operation: "ADD" })).ok, true);
  const next = {
    ...base,
    operation: "SUPERSEDE",
    body: "Владелец Дэйв.",
    history_entry: "2026-08-09: Владелец Алиса.",
  };
  const refused = await call(next);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /history_entry/u);
  assert.match(refused.error, /Владелец Кэрол\. Договор до марта\./u);
  const fix = example(refused.error);
  assert.equal(fix.operation, "SUPERSEDE");
  assert.equal(typeof fix.history_entry, "string");
  const resent = await call({ ...next, ...fix });
  assert.equal(resent.ok, true, resent.error);
  assert.equal(resent.action, "replaced");
});

// Seed в имени теста: провал воспроизводится подстановкой его же в fc.assert.
const TRUTH_SEED = 20260924;

void test(`SUPERSEDE refusal: the example history_entry passes for any Compiled Truth (seed ${String(TRUTH_SEED)})`, async () => {
  const word = fc.oneof(
    fc.constantFrom(
      "Ёлка",
      "владелец",
      "1.5",
      "9:30",
      "-",
      "«Кэрол»",
      "…",
      "+12",
    ),
    fc.stringMatching(/^[a-zA-Zа-яА-Я0-9.,:;!?()-]{1,14}$/u),
  );
  const line = fc
    .array(word, { minLength: 1, maxLength: 40 })
    .map((words) => words.join(" "));
  const body = fc
    .array(line, { minLength: 1, maxLength: 3 })
    .map((lines) => lines.join("\n"))
    .filter((text) => text.trim().length > 0 && !/^\s*[-*+]\s*$/mu.test(text));
  await fc.assert(
    fc.asyncProperty(body, async (truth) => {
      const base = card(truth);
      const created = await call({ ...base, operation: "ADD" });
      assert.equal(created.ok, true, created.error);
      const next = {
        ...base,
        operation: "SUPERSEDE",
        body: "Новый факт.",
        history_entry: "2000-01-01: не тот факт",
      };
      const refused = await call(next);
      assert.equal(refused.ok, false);
      assert.match(refused.error, /history_entry|UPDATE/u);
      const fix = example(refused.error);
      // Образец без history_entry (UPDATE) значит «пошли без него».
      const resent = await call({
        ...next,
        history_entry: undefined,
        ...fix,
      });
      assert.equal(resent.ok, true, `${refused.error}\n→ ${resent.error}`);
    }),
    { numRuns: 60, seed: TRUTH_SEED },
  );
});

void test("history_entry on UPDATE names the operation and shows the call without it", async () => {
  const base = card("Первый факт.");
  assert.equal((await call({ ...base, operation: "ADD" })).ok, true);
  const refused = await call({
    ...base,
    operation: "UPDATE",
    body: "Второй факт.",
    history_entry: "2026-09-01: Первый факт.",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /history_entry/u);
  assert.match(refused.error, /UPDATE/u);
  assert.match(refused.error, /SUPERSEDE/u);
  assert.deepEqual(example(refused.error), { operation: "UPDATE" });
});

void test("UPDATE and SUPERSEDE of a missing card point to ADD", async () => {
  for (const operation of ["UPDATE", "SUPERSEDE"]) {
    const refused = await call({
      ...card("Факт."),
      operation,
      history_entry: operation === "SUPERSEDE" ? "2026-09-01: старое" : "",
    });
    assert.equal(refused.ok, false, operation);
    assert.match(refused.error, new RegExp(`${operation} требует`, "u"));
    assert.deepEqual(example(refused.error), { operation: "ADD" }, operation);
  }
});

void test("a heading in body names the heading line and shows it as a plain line", async () => {
  for (const operation of ["ADD", "UPDATE"]) {
    const base = card("Факт.");
    if (operation === "UPDATE")
      assert.equal((await call({ ...base, operation: "ADD" })).ok, true);
    const refused = await call({
      ...base,
      operation,
      body: "Вступление.\n\n## Итоги встречи\nРешили ехать.",
    });
    assert.equal(refused.ok, false, operation);
    assert.match(refused.error, /body/u);
    assert.match(refused.error, /"## Итоги встречи"/u);
    assert.deepEqual(example(refused.error), { body: "Итоги встречи: …" });
  }
});

void test("## Related in body shows the links as the related field", async () => {
  const refused = await call({
    ...card("Факт."),
    operation: "ADD",
    body: "Факт.\n\n## Related\n- [[cards/notes/hub]]\n- [[hub|Хаб]]",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /related/u);
  assert.deepEqual(example(refused.error), {
    related: ["cards/notes/hub", "hub"],
  });
});

void test("a status outside the type names the allowed ones and shows one", async () => {
  const refused = await call({
    ...card("Факт."),
    operation: "ADD",
    status: "done",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /status "done"/u);
  assert.deepEqual(example(refused.error), { status: "active" });
});
