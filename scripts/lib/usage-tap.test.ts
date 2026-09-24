// Расход компактации eve в usage.jsonl. Компактация идёт настоящая, из eve: тот же
// compactMessages, что зовёт tool-loop, с моделью, обёрнутой нашим звеном. Так тест
// пинует и признак вызова (system-промпт eve), и форму расхода провайдера.
//
// КАК ВОСПРОИЗВЕСТИ ПАДЕНИЕ: seed в имени теста; fc.assert(prop, { seed: SEED, path }).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import fc from "fast-check";
import {
  compactionUsageMiddleware,
  providerUsageTokens,
  recordTapUsage,
  stepUsageLabel,
  type UsageLabel,
} from "#lib/usage-tap.ts";
import { formatUsageReport, readEntries, summarize } from "./usage.ts";
import { appendUsage } from "#lib/usage.ts";

const SEED = 20_260_924;

// Внутренний модуль eve: публичного экспорта у компактации нет, а проверить нужно именно
// её вызов модели, а не наш пересказ этого вызова.
const { compactMessages } = (await import(
  new URL(
    "../../node_modules/eve/dist/src/harness/compaction.js",
    import.meta.url,
  ).href
)) as {
  compactMessages: (
    messages: unknown[],
    model: unknown,
    config: Record<string, number>,
    providerOptions?: unknown,
    telemetry?: unknown,
    headers?: unknown,
    abortSignal?: unknown,
    force?: boolean,
  ) => Promise<unknown[]>;
};

type Usage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: {
    total: number | undefined;
    text: number | undefined;
    reasoning: number | undefined;
  };
};

function usage(input: number, cacheRead: number, output: number): Usage {
  return {
    inputTokens: {
      total: input,
      noCache: input - cacheRead,
      cacheRead,
      cacheWrite: 0,
    },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function mockModel(reply: Usage) {
  return new MockLanguageModelV4({
    doGenerate: () =>
      Promise.resolve({
        content: [{ type: "text", text: "summary of the conversation" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: reply,
        warnings: [],
      }),
  });
}

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "iva-usage-tap-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  const restore = (): void => {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = run(dir);
    if (result instanceof Promise)
      return result.finally(restore) as unknown as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const HISTORY = [
  { role: "user", content: "расскажи про план ".repeat(40) },
  { role: "assistant", content: "план такой ".repeat(40) },
  { role: "user", content: "дальше" },
];
const CONFIG = {
  threshold: 100_000,
  recentWindowSize: 1,
  thresholdPercent: 0.7,
};
const LABEL: UsageLabel = { sessionId: "s1", turnId: "turn_3", step: 2 };

await test("компактация eve пишет строку расхода source=compaction с usage провайдера", () =>
  withDir(async (dir) => {
    const model = wrapLanguageModel({
      model: mockModel(usage(5000, 1000, 300)),
      middleware: [compactionUsageMiddleware(LABEL)],
    });
    await compactMessages(
      HISTORY,
      model,
      CONFIG,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    const rows = readEntries(dir);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    const [row] = rows;
    assert.equal(row.source, "compaction");
    assert.equal(row.sessionId, "s1");
    assert.equal(row.turnId, "turn_3#compaction");
    assert.equal(row.step, 2);
    assert.deepEqual(
      [row.in, row.out, row.cacheRead, row.cacheWrite, row.total],
      [5000, 300, 1000, 0, 5300],
    );
  }));

await test("обычный generateText через ту же модель строку компактации не пишет", () =>
  withDir(async (dir) => {
    const model = wrapLanguageModel({
      model: mockModel(usage(700, 0, 5)),
      middleware: [compactionUsageMiddleware(LABEL)],
    });
    await generateText({ model, system: "Ты Ива.", prompt: "What colour?" });
    assert.deepEqual(readEntries(dir), []);
  }));

await test("компактация входит в итог хода, но не выдаёт себя за контекст сессии", () =>
  withDir((dir) => {
    recordTapUsage(
      { source: "compaction", model: "m", label: LABEL },
      { in: 90_000, out: 2_000, cacheRead: 0, cacheWrite: 0 },
    );
    appendUsage(
      {
        ts: new Date().toISOString(),
        source: "channel:telegram",
        provider: "ollama",
        model: "m",
        sessionId: "s1",
        turnId: "turn_3",
        step: 2,
        in: 12_000,
        out: 100,
        cacheRead: 0,
        cacheWrite: 0,
        total: 12_100,
      },
      dir,
    );
    const entries = readEntries(dir);
    const last = summarize(entries, { window: "last" }).last;
    assert.ok(last);
    assert.equal(
      last.in,
      12_000,
      "контекст — вход шага, не транскрипт компактации",
    );
    assert.equal(last.total, 92_000 + 12_100);
    assert.equal(last.turns, 1);
    const bySource = formatUsageReport(
      summarize(entries, { window: "by-source" }),
    );
    assert.match(bySource, /compaction: 92 000 tokens/u);
  }));

// --- Свойства --------------------------------------------------------------------------

const NUMBER = fc.oneof(
  fc.integer({ min: 0, max: 5_000_000 }),
  fc.constantFrom(undefined, -1, 0.5, 1e308, Number.NaN, Infinity),
);

const USAGE: fc.Arbitrary<Usage> = fc.record({
  inputTokens: fc.record({
    total: NUMBER,
    noCache: NUMBER,
    cacheRead: NUMBER,
    cacheWrite: NUMBER,
  }),
  outputTokens: fc.record({ total: NUMBER, text: NUMBER, reasoning: NUMBER }),
});

const valid = (value: number | undefined): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0);

await test(`расход провайдера: строка только из целых чисел, и ровно они (seed ${SEED})`, (t) => {
  const original = console.error;
  console.error = () => undefined;
  t.after(() => {
    console.error = original;
  });
  fc.assert(
    fc.property(USAGE, (reply) => {
      withDir((dir) => {
        recordTapUsage(
          { source: "compaction", model: "m", label: LABEL },
          providerUsageTokens(reply),
        );
        const rows = readEntries(dir);
        const input = reply.inputTokens;
        const numbers = [
          input.total,
          reply.outputTokens.total,
          input.cacheRead,
          input.cacheWrite,
        ];
        const nonZero = numbers.some((value) => (value ?? 0) > 0);
        if (!numbers.every(valid) || !nonZero) {
          assert.deepEqual(rows, [], `записан мусор: ${JSON.stringify(reply)}`);
          return;
        }
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.deepEqual(
          [row.in, row.out, row.cacheRead, row.cacheWrite],
          numbers.map((value) => value ?? 0),
        );
        assert.equal(row.total, row.in + row.out);
      });
    }),
    { seed: SEED, numRuns: 200 },
  );
});

await test(`метка шага из события резолвера не падает на мусоре (seed ${SEED})`, () => {
  fc.assert(
    fc.property(fc.anything(), fc.string(), (event, sessionId) => {
      const label = stepUsageLabel(event, sessionId);
      assert.equal(label.sessionId, sessionId);
      assert.equal(typeof label.turnId, "string");
      assert.ok(Number.isSafeInteger(label.step));
    }),
    { seed: SEED, numRuns: 300 },
  );
  fc.assert(
    fc.property(
      fc.string(),
      fc.nat(),
      fc.string(),
      (turnId, stepIndex, sessionId) => {
        const label = stepUsageLabel(
          { type: "step.started", data: { sequence: 1, stepIndex, turnId } },
          sessionId,
        );
        assert.deepEqual(label, { sessionId, turnId, step: stepIndex });
      },
    ),
    { seed: SEED, numRuns: 200 },
  );
});
