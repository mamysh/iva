import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { needsRichMessage } from "./lib/telegram-format.mjs";

const instructions = readFileSync(new URL("../agent/instructions.md", import.meta.url), "utf8");
assert.match(instructions, /## Формат ответа/);
assert.match(instructions, /таблиц|чек-лист|структурированн/i);
assert.match(instructions, /коротк.*подтверждени|вопрос.*обычн/i);

const structuredReport = [
  "## Итог",
  "Подробное резюме результата и принятых решений. ".repeat(5),
  "## Риски",
  "Перечень ограничений, последствий и мер контроля. ".repeat(5),
  "## Следующие шаги",
  "План реализации, проверки и безопасного выпуска. ".repeat(5),
].join("\n\n");
assert.equal(needsRichMessage(structuredReport), true, "long multi-section report should use rich transport");
assert.equal(needsRichMessage("Готово."), false, "short confirmation should stay on normal transport");
assert.equal(needsRichMessage("Продолжить с этим вариантом?"), false, "short question should stay normal");

console.log("rich report policy checks passed: report rich, short confirmation/question normal");
