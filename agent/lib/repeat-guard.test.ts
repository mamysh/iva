import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { wrapLanguageModel } from "ai";
import { MockLanguageModelV4, convertReadableStreamToArray } from "ai/test";
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { inspectRepeatGuard, repeatGuardMiddleware } from "./repeat-guard.ts";
import {
  traceDay,
  traceFilePath,
  traceRepeatGuard,
  traceWithScope,
} from "./trace.ts";

const testDataDir = mkdtempSync(join(tmpdir(), "iva-repeat-guard-tests-"));
const previousDataDir = process.env.ASSISTANT_DATA_DIR;
process.env.ASSISTANT_DATA_DIR = testDataDir;
process.on("exit", () => {
  if (previousDataDir === undefined) delete process.env.ASSISTANT_DATA_DIR;
  else process.env.ASSISTANT_DATA_DIR = previousDataDir;
  rmSync(testDataDir, { recursive: true, force: true });
});

function pair(
  id: string,
  tool: string,
  input: unknown,
  output: {
    type: "text" | "error-text" | "json" | "error-json";
    value: unknown;
  },
): LanguageModelV4Prompt {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: tool, input }],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: id, toolName: tool, output },
      ],
    },
  ] as LanguageModelV4Prompt;
}

const user: LanguageModelV4Prompt[number] = {
  role: "user",
  content: [{ type: "text", text: "сделай" }],
};
const failed = (id: string, input: unknown = { path: "x" }) =>
  pair(id, "read_file", input, {
    type: "error-text",
    value: "ENOENT /tmp/work-1234 at 06:00:01 pid 12345",
  });
const success = (id: string) =>
  pair(id, "read_file", { path: "ok" }, { type: "text", value: "готово" });

void test("two identical failures pass; three stop", () => {
  assert.equal(
    inspectRepeatGuard([user, ...failed("a"), ...failed("b")]).stop,
    undefined,
  );
  const verdict = inspectRepeatGuard([
    user,
    ...failed("a"),
    ...failed("b"),
    ...failed("c"),
  ]).stop;
  assert.equal(verdict?.tool, "read_file");
  assert.equal(verdict?.count, 3);
  assert.ok(verdict?.message.includes("3 раза подряд"));
});

void test("success resets the streak, including a JSON success", () => {
  const jsonSuccess = pair(
    "ok",
    "read_file",
    {},
    { type: "json", value: { ok: true } },
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...success("ok"),
      ...failed("c"),
    ]).stop,
    undefined,
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...jsonSuccess,
      ...failed("c"),
    ]).stop,
    undefined,
  );
});

void test("seven varied failures pass; eight of one tool stop", () => {
  const attempts = Array.from({ length: 8 }, (_, i) =>
    failed(String(i), { path: String(i) }),
  );
  assert.equal(
    inspectRepeatGuard([user, ...attempts.slice(0, 7).flat()]).stop,
    undefined,
  );
  assert.equal(inspectRepeatGuard([user, ...attempts.flat()]).stop?.count, 8);
});

void test("timestamps, numeric IDs and tmp paths do not split one error", () => {
  const p = [
    ...failed("a"),
    ...pair(
      "b",
      "read_file",
      { path: "x" },
      {
        type: "error-text",
        value: "ENOENT /tmp/other-9876 at 06:01:49 pid 76543",
      },
    ),
    ...pair(
      "c",
      "read_file",
      { path: "x" },
      {
        type: "error-text",
        value: "ENOENT /private/tmp/third-3456 at 06:02:20 pid 87654",
      },
    ),
  ];
  assert.equal(inspectRepeatGuard([user, ...p]).stop?.count, 3);
});

void test("new user turn cuts the series; 100 successful calls pass", () => {
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      user,
      ...failed("c"),
    ]).stop,
    undefined,
  );
  assert.equal(
    inspectRepeatGuard([
      user,
      ...Array.from({ length: 100 }, (_, i) => success(String(i))).flat(),
    ]).stop,
    undefined,
  );
});

void test("JSON key order is canonical; different tools and error text break exact streak", () => {
  const same = [
    ...pair(
      "a",
      "read_file",
      { b: 2, a: { z: 1, y: 2 } },
      { type: "error-json", value: { error: "denied" } },
    ),
    ...pair(
      "b",
      "read_file",
      { a: { y: 2, z: 1 }, b: 2 },
      { type: "error-json", value: { error: "denied" } },
    ),
    ...pair(
      "c",
      "read_file",
      { a: { y: 2, z: 1 }, b: 2 },
      { type: "error-json", value: { error: "denied" } },
    ),
  ];
  assert.equal(inspectRepeatGuard([user, ...same]).stop?.count, 3);
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...pair("b", "write_file", {}, { type: "error-text", value: "bad" }),
      ...failed("c"),
    ]).stop,
    undefined,
  );
});

void test("a string argument remains distinct from a numeric argument", () => {
  const p = [
    ...pair(
      "a",
      "read_file",
      { offset: "123" },
      { type: "error-text", value: "bad" },
    ),
    ...pair(
      "b",
      "read_file",
      { offset: 123 },
      { type: "error-text", value: "bad" },
    ),
    ...pair(
      "c",
      "read_file",
      { offset: "123" },
      { type: "error-text", value: "bad" },
    ),
  ];
  assert.equal(inspectRepeatGuard([user, ...p]).stop, undefined);
});

void test("ordinary text and JSON outputs with ok:false or nonempty error are failures", () => {
  const p = [
    ...pair(
      "a",
      "bash",
      {},
      { type: "json", value: { ok: false, error: "failed" } },
    ),
    ...pair(
      "b",
      "bash",
      {},
      { type: "text", value: '{"error":"failed","ok":false}' },
    ),
    ...pair("c", "bash", {}, { type: "json", value: { error: "failed" } }),
  ];
  assert.equal(inspectRepeatGuard([user, ...p]).stop?.count, 3);
});

void test("unpaired tool results and outstanding calls never trigger a stop", () => {
  const orphan = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "orphan",
        toolName: "read_file",
        output: { type: "error-text", value: "bad" },
      },
    ],
  } as LanguageModelV4Prompt[number];
  assert.equal(
    inspectRepeatGuard([user, orphan, orphan, orphan]).stop,
    undefined,
  );
  const pending = {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "pending",
        toolName: "read_file",
        input: {},
      },
    ],
  } as LanguageModelV4Prompt[number];
  assert.equal(
    inspectRepeatGuard([
      user,
      ...failed("a"),
      ...failed("b"),
      ...failed("c"),
      pending,
    ]).stop,
    undefined,
  );
});

void test("seed=76001: every history ending in success passes", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { maxLength: 30 }), (states) => {
      const history = states.flatMap((bad, i) =>
        bad ? failed(String(i)) : success(String(i)),
      );
      return (
        inspectRepeatGuard([user, ...history, ...success("last")]).stop ===
        undefined
      );
    }),
    { seed: 76001 },
  );
});

void test("seed=76002: any history ending in at least three identical failures stops", () => {
  fc.assert(
    fc.property(
      fc.array(fc.boolean(), { maxLength: 30 }),
      fc.integer({ min: 3, max: 12 }),
      (states, count) => {
        const history = states.flatMap((bad, i) =>
          bad ? failed(String(i), { path: String(i) }) : success(String(i)),
        );
        const suffix = Array.from({ length: count }, (_, i) =>
          failed(`tail-${i}`, { path: "same" }),
        ).flat();
        return (
          inspectRepeatGuard([user, ...history, ...suffix]).stop !== undefined
        );
      },
    ),
    { seed: 76002 },
  );
});

void test("stream middleware skips model on stop and passes model stream through otherwise", async () => {
  let called = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doStream: () => {
        called++;
        return Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start(c) {
              c.enqueue({ type: "text-start", id: "real" });
              c.enqueue({ type: "text-delta", id: "real", delta: "real" });
              c.close();
            },
          }),
        });
      },
    }),
    middleware: repeatGuardMiddleware,
  });
  const stopped = await convertReadableStreamToArray(
    (
      await model.doStream({
        prompt: [user, ...failed("a"), ...failed("b"), ...failed("c")],
      })
    ).stream,
  );
  assert.equal(called, 0);
  assert.equal(
    stopped.some((part) => part.type === "tool-call"),
    false,
  );
  assert.equal(
    stopped.find((part) => part.type === "finish")?.finishReason.unified,
    "stop",
  );
  assert.ok(
    stopped.some(
      (part) => part.type === "text-delta" && part.delta.includes("read_file"),
    ),
  );
  const passed = await convertReadableStreamToArray(
    (await model.doStream({ prompt: [user, ...failed("a")] })).stream,
  );
  assert.equal(called, 1);
  assert.deepEqual(passed, [
    { type: "text-start", id: "real" },
    { type: "text-delta", id: "real", delta: "real" },
  ]);
});

void test("generate middleware returns only text with zero usage and does not call model", async () => {
  let called = 0;
  const model = wrapLanguageModel({
    model: new MockLanguageModelV4({
      doGenerate: () => {
        called++;
        throw new Error("model should not run");
      },
    }),
    middleware: repeatGuardMiddleware,
  });
  const result = await model.doGenerate({
    prompt: [user, ...failed("gen-a"), ...failed("gen-b"), ...failed("gen-c")],
  });
  assert.equal(called, 0);
  assert.deepEqual(
    result.content.map((part) => part.type),
    ["text"],
  );
  assert.equal(result.finishReason.unified, "stop");
  assert.equal(result.usage.inputTokens.total, 0);
  assert.equal(result.usage.outputTokens.total, 0);
});

void test("a rejected call is journaled even when no turn scope exists", () => {
  traceRepeatGuard("tool.rejected", {
    tool: "fallback_probe",
    errorHead: "invalid input",
  });
  const lines = readFileSync(traceFilePath(traceDay(), testDataDir), "utf8")
    .trim()
    .split("\n");
  const event = lines
    .map(
      (line) =>
        JSON.parse(line) as {
          kind: string;
          name: string;
          turn: string;
          data: { tool?: string };
        },
    )
    .find((item) => item.data.tool === "fallback_probe");
  assert.equal(event?.kind, "tool");
  assert.equal(event?.name, "rejected");
  assert.equal(event?.turn, "");
});

void test("trace logs each rejected call ID once and records the stop without arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "iva-repeat-guard-"));
  const previous = process.env.ASSISTANT_DATA_DIR;
  process.env.ASSISTANT_DATA_DIR = dir;
  try {
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doStream: () =>
          Promise.resolve({
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(c) {
                c.close();
              },
            }),
          }),
      }),
      middleware: repeatGuardMiddleware,
    });
    const prompts = [
      [user, ...failed("journal-a")],
      [user, ...failed("journal-a"), ...failed("journal-b")],
      [
        user,
        ...failed("journal-a"),
        ...failed("journal-b"),
        ...failed("journal-c"),
      ],
    ];
    await traceWithScope(
      { turn: "turn-76", session: "session-76" },
      async () => {
        for (const prompt of [...prompts, prompts[2]]) {
          await convertReadableStreamToArray(
            (await model.doStream({ prompt })).stream,
          );
        }
      },
    );
    const events = readFileSync(traceFilePath(traceDay(), dir), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            name: string;
            turn: string;
            data: Record<string, unknown>;
          },
      );
    assert.equal(
      events.filter((e) => e.kind === "tool" && e.name === "rejected").length,
      3,
    );
    assert.equal(
      events.filter((e) => e.kind === "guard" && e.name === "repeat_stop")
        .length,
      2,
    );
    for (const event of events) {
      assert.equal(event.turn, "turn-76");
      assert.ok(String(event.data.errorHead).length <= 160);
      assert.equal("input" in event.data, false);
    }
  } finally {
    if (previous === undefined) delete process.env.ASSISTANT_DATA_DIR;
    else process.env.ASSISTANT_DATA_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
