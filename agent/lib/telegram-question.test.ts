import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramChannel, type TelegramHandle } from "eve/channels/telegram";
import {
  flushSettledTelegramQuestions,
  postTelegramQuestion,
  settleTelegramQuestions,
  type QuestionState,
} from "./telegram-question.ts";

void test("authoritative resolution removes buttons; edit failure never loses accepted answer", async () => {
  const calls: Array<{ method: string; body: unknown }> = [];
  let fail = false;
  const tg = {
    chatId: "7",
    post(body: unknown) {
      calls.push({ method: "sendMessage", body });
      return Promise.resolve({ id: "9", raw: { text: "Confirm?" } });
    },
    request(method: string, body: unknown) {
      calls.push({ method, body });
      return Promise.resolve({
        ok: !fail,
        status: 200,
        body: { ok: !fail, result: { message_id: 9 } },
      });
    },
  } as Pick<TelegramHandle, "chatId" | "request" | "post">;
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: null,
  };
  await postTelegramQuestion(
    {
      requestId: "q",
      action: {
        callId: "c",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      kind: "question",
      prompt: "Confirm?",
      options: [{ id: "yes", label: "Yes" }],
    },
    state,
    tg,
  );
  assert.ok(state.questionCards?.q);
  fail = true;
  await settleTelegramQuestions(
    [{ requestId: "q", outcome: "answered", response: { optionId: "yes" } }],
    state,
    tg,
  );
  assert.ok(state.questionCards?.q);
  fail = false;
  const resumed = JSON.parse(JSON.stringify(state)) as QuestionState;
  await flushSettledTelegramQuestions(resumed, tg);
  assert.equal(resumed.questionCards?.q, undefined);
  await flushSettledTelegramQuestions(state, tg);
  assert.equal(state.questionCards?.q, undefined);
  const last = calls.at(-1)!.body as {
    text: string;
    reply_markup: { inline_keyboard: unknown[] };
  };
  assert.match(last.text, /Yes/u);
  assert.deepEqual(last.reply_markup.inline_keyboard, []);
  assert.equal(calls.filter((call) => call.method === "sendMessage").length, 1);
});

void test("Eve compiles the input.resolved public handler into its adapter", () => {
  const callback = () => {};
  const channel = telegramChannel({ events: { "input.resolved": callback } });
  // Introspection in the contract test, not a runtime monkey patch.
  assert.equal(
    typeof Reflect.get(Reflect.get(channel, "adapter"), "input.resolved"),
    "function",
  );
});

void test("rich resolution edits embedded buttons and never echoes a freeform answer", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const state: QuestionState = {
    chatId: "7",
    chatType: "private",
    conversationId: null,
    messageThreadId: 42,
  };
  const tg = {
    chatId: "7",
    messageThreadId: 42,
    post: () => {
      throw new Error("unexpected native fallback");
    },
    request(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 9 } },
      });
    },
  } as unknown as TelegramHandle;
  await postTelegramQuestion(
    {
      requestId: "q-rich",
      kind: "question",
      prompt: "Accept <literal>?",
      action: {
        callId: "c",
        input: {},
        kind: "tool-call",
        toolName: "ask_question",
      },
      options: [{ id: "yes", label: "Yes" }],
      allowFreeform: true,
    },
    state,
    tg,
    true,
  );
  assert.equal(calls[0].method, "sendRichMessage");
  assert.equal(calls[0].body.message_thread_id, 42);
  assert.match(
    (calls[0].body.rich_message as { markdown: string }).markdown,
    /tg-button/u,
  );
  assert.ok(Object.keys(state.hitlCallbacks ?? {}).length);
  assert.equal(state.pendingFreeformReplies?.["9"], "q-rich");
  await settleTelegramQuestions(
    [
      {
        requestId: "q-rich",
        outcome: "answered",
        response: { text: "private-freeform-value" },
      },
    ],
    state,
    tg,
  );
  assert.equal(calls[1].method, "editMessageText");
  assert.equal(calls[1].body.message_id, 9);
  assert.doesNotMatch(
    JSON.stringify(calls[1].body),
    /tg-button|private-freeform-value/u,
  );
  assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [] });
  assert.deepEqual(state.hitlCallbacks, {});
  assert.deepEqual(state.pendingFreeformReplies, {});
  assert.deepEqual(state.questionCards, {});
});
