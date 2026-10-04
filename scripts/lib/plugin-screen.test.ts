import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  createPluginScreens,
  parseScreenCallback,
  screenMarkdown,
  screenViewSchema,
  type ScreenEvent,
} from "./plugin-screen.ts";

const view = {
  markdown: "# Settings",
  rows: [[{ id: "next", label: "Next" }]],
};
async function world(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "iva-screen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let enabled = true;
  let failEdit = false;
  let calls = 0;
  let clock = 1000;
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  const events: ScreenEvent[] = [];
  const endpoint = {
    plugin: "demo",
    command: "/demo",
    fingerprint: "sha1",
    call(event: ScreenEvent) {
      events.push(event);
      calls++;
      return Promise.resolve({
        type: "show",
        view: { ...view, markdown: `# Page ${calls}` },
      });
    },
  };
  const options = {
    dataDir: dir,
    allowed: (id: number) => id === 7,
    rich: () => true,
    now: () => clock,
    endpoints: () => Promise.resolve(enabled ? [endpoint] : []),
    call(method: string, body: Record<string, unknown>) {
      sent.push({ method, body });
      return Promise.resolve({
        ok: !(failEdit && method === "editMessageText"),
        result: { message_id: 9 },
      });
    },
  };
  const engine = createPluginScreens(options);
  await engine.open("/demo", 7, 7, true);
  const rich = sent[0].body.rich_message as { markdown: string };
  const data = /data="([^"]+)"/u.exec(rich.markdown)![1];
  const tap = { data, chatId: 7, messageId: 9, userId: 7, privateChat: true };
  return {
    dir,
    engine,
    sent,
    events,
    tap,
    options,
    disable: () => {
      enabled = false;
    },
    fail: (value: boolean) => {
      failEdit = value;
    },
    expire: () => {
      clock += 16 * 60000;
    },
  };
}

void test("one initial send, then same-message edits without another handler call on replay", async (t) => {
  const w = await world(t);
  assert.equal(await w.engine.tap(w.tap), "");
  assert.equal(w.events.length, 2);
  assert.equal(await createPluginScreens(w.options).tap(w.tap), "");
  assert.equal(w.events.length, 2);
  assert.deepEqual(
    w.sent.map((item) => item.method),
    ["sendRichMessage", "editMessageText", "editMessageText"],
  );
  assert.equal(w.sent[1].body.message_id, 9);
});

void test("failed edit retries delivery across restart, not plugin action", async (t) => {
  const w = await world(t);
  w.fail(true);
  await assert.rejects(w.engine.tap(w.tap));
  w.fail(false);
  assert.equal(await createPluginScreens(w.options).tap(w.tap), "");
  assert.equal(w.events.length, 2);
  assert.equal(
    w.sent.filter((item) => item.method.startsWith("send")).length,
    1,
  );
});

void test("identity, message, private chat, expiry and disabled plugin are checked before call", async (t) => {
  const w = await world(t);
  for (const change of [
    { userId: 8 },
    { chatId: 8 },
    { messageId: 10 },
    { privateChat: false },
  ])
    assert.notEqual(await w.engine.tap({ ...w.tap, ...change }), "");
  assert.equal(w.events.length, 1);
  w.disable();
  assert.notEqual(await w.engine.tap(w.tap), "");
  assert.equal(w.events.length, 1);
  w.expire();
  assert.notEqual(await w.engine.tap(w.tap), "");
});

void test("parallel taps serialize and an uncertain handler is never replayed", async (t) => {
  const w = await world(t);
  await Promise.all([w.engine.tap(w.tap), w.engine.tap(w.tap)]);
  assert.equal(w.events.length, 2);
  const rich = w.sent.at(-1)!.body.rich_message as { markdown: string };
  const data = /data="([^"]+)"/u.exec(rich.markdown)![1];
  const endpoints = await w.options.endpoints();
  endpoints[0].call = () => Promise.reject(new Error("uncertain"));
  await assert.rejects(w.engine.tap({ ...w.tap, data }));
  assert.notEqual(
    await createPluginScreens(w.options).tap({ ...w.tap, data }),
    "",
  );
  const file = (await readdir(join(w.dir, "telegram-screens"))).find((name) =>
    name.endsWith(".json"),
  )!;
  const state: unknown = JSON.parse(
    await readFile(join(w.dir, "telegram-screens", file), "utf8"),
  );
  assert.equal((state as { phase: string }).phase, "busy");
});

void test("callback parser rejects arbitrary data; generated callbacks fit Telegram's 64-byte cap", () => {
  fc.assert(
    fc.property(fc.string(), (data) => {
      const parsed = parseScreenCallback(data);
      if (parsed) assert.match(parsed.id, /^[a-f0-9]{32}$/u);
    }),
  );
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 999999 }), (revision) => {
      const markdown = screenMarkdown({ view, revision }, "a".repeat(32));
      const data = /data="([^"]+)"/u.exec(markdown)![1];
      assert.ok(Buffer.byteLength(data) <= 64);
      assert.equal(parseScreenCallback(data)?.revision, revision);
    }),
  );
  assert.equal(
    screenViewSchema.safeParse({
      ...view,
      markdown: '<tg-button data="evil">x</tg-button>',
    }).success,
    false,
  );
  assert.equal(
    screenViewSchema.safeParse({
      ...view,
      rows: [[view.rows[0][0], view.rows[0][0]]],
    }).success,
    false,
  );
});
