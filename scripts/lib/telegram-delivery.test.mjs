import assert from "node:assert/strict";

import { deliverTelegramMarkdown } from "./telegram-delivery.mjs";

const report = "| check | result |\n|---|---|\n| secret | [REDACTED] |";

{
  const calls = [];
  const result = await deliverTelegramMarkdown({
    markdown: report,
    sendRich: async (text) => { calls.push(["rich", text]); return { ok: true }; },
    sendHtml: async (html) => calls.push(["html", html]),
    sendPlain: async (plain) => calls.push(["plain", plain]),
  });
  assert.deepEqual(result, { transport: "rich", messages: 1, fellBack: false });
  assert.deepEqual(calls.map(([kind]) => kind), ["rich"], "rich success must not duplicate delivery");
}

{
  const calls = [];
  const result = await deliverTelegramMarkdown({
    markdown: report,
    sendRich: async (text) => { calls.push(["rich", text]); return { ok: false, status: 400 }; },
    sendHtml: async (html) => calls.push(["html", html]),
    sendPlain: async (plain) => calls.push(["plain", plain]),
  });
  assert.equal(result.transport, "html");
  assert.deepEqual(calls.map(([kind]) => kind), ["rich", "html"]);
  assert.ok(calls.every(([, body]) => body.includes("[REDACTED]")));
}

{
  const calls = [];
  const failures = [];
  const result = await deliverTelegramMarkdown({
    markdown: report,
    sendRich: async (text) => { calls.push(["rich", text]); throw new Error("unsupported"); },
    sendHtml: async (html) => { calls.push(["html", html]); throw new Error("bad entities"); },
    sendPlain: async (plain) => calls.push(["plain", plain]),
    onFailure: (stage) => failures.push(stage),
  });
  assert.equal(result.transport, "plain");
  assert.deepEqual(calls.map(([kind]) => kind), ["rich", "html", "plain"]);
  assert.deepEqual(failures, ["rich-failed", "html-failed"]);
  assert.ok(calls.every(([, body]) => body.includes("[REDACTED]")));
}

{
  const calls = [];
  const result = await deliverTelegramMarkdown({
    markdown: "Готово.",
    sendRich: async () => { throw new Error("short replies must not use rich transport"); },
    sendHtml: async (html) => calls.push(["html", html]),
    sendPlain: async (plain) => calls.push(["plain", plain]),
  });
  assert.deepEqual(result, { transport: "html", messages: 1, fellBack: false });
  assert.deepEqual(calls.map(([kind]) => kind), ["html"]);
}

{
  const failures = [];
  const result = await deliverTelegramMarkdown({
    markdown: report,
    sendRich: async () => ({ ok: false }),
    sendHtml: async () => { throw new Error("bad entities"); },
    sendPlain: async () => { throw new Error("transport unavailable"); },
    onFailure: (stage) => failures.push(stage),
  });
  assert.deepEqual(result, { transport: "plain", messages: 0, fellBack: true });
  assert.deepEqual(failures, ["rich-rejected", "html-failed", "plain-failed"]);
}

console.log("telegram delivery checks passed: rich, HTML and plain fallback without duplicates");
