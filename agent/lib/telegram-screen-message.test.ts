import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliverScreenMessage,
  type ScreenCall,
} from "./telegram-screen-message.ts";

void test("screen edits never send a new message and recognize Telegram's unchanged result", async () => {
  const calls: string[] = [];
  const call: ScreenCall = (method) => {
    calls.push(method);
    return Promise.resolve({
      ok: false,
      description: "Bad Request: message is not modified",
    });
  };
  assert.equal(
    await deliverScreenMessage(call, 7, "# Hello", {
      messageId: 9,
      rich: true,
    }),
    9,
  );
  assert.deepEqual(calls, ["editMessageText"]);
  await assert.rejects(
    deliverScreenMessage(() => Promise.resolve({ ok: false }), 7, "x", {
      messageId: 9,
    }),
  );
});

void test("classic delivery formats text and carries buttons without treating labels as markup", async () => {
  let body: Record<string, unknown> | undefined;
  await deliverScreenMessage(
    (_method, value) => {
      body = value;
      return Promise.resolve({ ok: true, result: { message_id: 9 } });
    },
    7,
    "**Settings**\n\n```bash\nprintf hello\n```",
    { keyboard: [[{ text: "Next", callback_data: "callback" }]] },
  );
  assert.equal(body?.parse_mode, "HTML");
  assert.match(String(body?.text), /<b>Settings<\/b>/u);
  assert.match(String(body?.text), /<pre>/u);
});
