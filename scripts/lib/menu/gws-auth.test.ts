/* eslint-disable @typescript-eslint/no-floating-promises -- Node's test runner owns registration promises. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { parseAuthChallenge, extractCallbackQuery } from "./gws-auth.ts";

test("parseAuthChallenge extracts the Google URL and loopback port", () => {
  const log = [
    "Open this URL in your browser to authenticate:",
    "",
    "  https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=http://localhost:44369&response_type=code&client_id=abc",
    "",
  ].join("\n");
  const r = parseAuthChallenge(log);
  assert.ok(r);
  assert.equal(r.port, 44369);
  assert.ok(r.url.startsWith("https://accounts.google.com/o/oauth2/auth?"));
  assert.ok(r.url.includes("redirect_uri=http://localhost:44369"));
});

test("parseAuthChallenge accepts 127.0.0.1 loopback", () => {
  const log =
    "go: https://accounts.google.com/o/oauth2/auth?redirect_uri=http://127.0.0.1:51000&x=1";
  const r = parseAuthChallenge(log);
  assert.ok(r);
  assert.equal(r.port, 51000);
});

test("parseAuthChallenge returns null when the URL is not printed yet", () => {
  assert.equal(parseAuthChallenge("starting auth..."), null);
  assert.equal(parseAuthChallenge(""), null);
});

const SEED = 20260924;

function consentUrl(redirect: string): string {
  return `https://accounts.google.com/o/oauth2/auth?scope=x&redirect_uri=${redirect}&response_type=code&client_id=synthetic`;
}

test("parseAuthChallenge reads a URL-encoded loopback redirect_uri (gws 0.22.5)", () => {
  const url = consentUrl("http%3A%2F%2Flocalhost%3A41803%2F");
  assert.deepEqual(
    parseAuthChallenge(`Open this URL in your browser:\n\n${url}\n`),
    { url, port: 41803 },
  );
});

test("parseAuthChallenge reads a URL-encoded 127.0.0.1 redirect_uri", () => {
  const url = consentUrl("http%3A%2F%2F127.0.0.1%3A51000%2F");
  assert.deepEqual(parseAuthChallenge(`go: ${url}`), { url, port: 51000 });
});

test("parseAuthChallenge keeps an explicit :80 that URL treats as the default port", () => {
  for (const redirect of [
    "http%3A%2F%2Flocalhost%3A80%2F",
    "http://127.0.0.1:80",
  ]) {
    assert.equal(parseAuthChallenge(consentUrl(redirect))?.port, 80, redirect);
  }
});

test("parseAuthChallenge rejects a redirect_uri that is not a valid loopback port", () => {
  const rejected = [
    "http%3A%2F%2Fexample.com%3A41803%2F",
    "http://example.com:41803",
    "https%3A%2F%2Flocalhost%3A41803%2F",
    "https://localhost:41803",
    "http%3A%2F%2Flocalhost%2F",
    "http://localhost",
    "http%3A%2F%2Flocalhost%3A0%2F",
    "http://localhost:0",
    "http%3A%2F%2Flocalhost%3A65536%2F",
    "http://localhost:65536",
    "http%3A%2F%2F%5B%3A41803%2F",
    "not-a-url",
    "",
  ];
  for (const redirect of rejected) {
    assert.equal(parseAuthChallenge(consentUrl(redirect)), null, redirect);
  }
  assert.equal(
    parseAuthChallenge("https://accounts.google.com/o/oauth2/auth?scope=x"),
    null,
  );
});

test(`parseAuthChallenge reads the same port from encoded and raw redirect_uri (seed ${SEED})`, () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.integer({ min: 1, max: 65535 }),
        fc.constantFrom(1, 80, 65535),
      ),
      fc.constantFrom("localhost", "127.0.0.1"),
      fc.boolean(),
      (port, host, slash) => {
        const raw = `http://${host}:${port}${slash ? "/" : ""}`;
        const encoded = parseAuthChallenge(consentUrl(encodeURIComponent(raw)));
        const plain = parseAuthChallenge(consentUrl(raw));
        assert.equal(encoded?.port, port);
        assert.equal(plain?.port, port);
      },
    ),
    { seed: SEED, numRuns: 300 },
  );
});

test("extractCallbackQuery pulls the query from a full redirect URL", () => {
  const q = extractCallbackQuery(
    "http://localhost:44369/?code=4/0ABC_def-123&scope=email%20profile&authuser=0",
  );
  assert.equal(q, "code=4/0ABC_def-123&scope=email%20profile&authuser=0");
});

test("extractCallbackQuery tolerates surrounding whitespace/newlines", () => {
  const q = extractCallbackQuery("  http://localhost:1/?code=4/0X&state=y \n");
  assert.equal(q, "code=4/0X&state=y");
});

test("extractCallbackQuery accepts a bare query string", () => {
  assert.equal(extractCallbackQuery("code=4/0X&scope=y"), "code=4/0X&scope=y");
});

test("extractCallbackQuery accepts a bare authorization code", () => {
  assert.equal(
    extractCallbackQuery("4/0AXEQabc-DEF_123"),
    "code=4/0AXEQabc-DEF_123",
  );
});

test("extractCallbackQuery returns null when there is no code", () => {
  assert.equal(extractCallbackQuery("hello there"), null);
  assert.equal(extractCallbackQuery("http://localhost:1/?scope=y"), null);
  assert.equal(extractCallbackQuery(""), null);
});
