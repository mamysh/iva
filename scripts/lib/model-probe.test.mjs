import assert from "node:assert/strict";

import { runBoundedModelProbe } from "./model-probe.mjs";

let captured;
const executeOk = (file, args, options, callback) => {
  captured = { file, args, options };
  callback(null, "ok\n", "");
};
await runBoundedModelProbe({
  root: "/fixture/iva",
  role: "vision",
  env: { OLLAMA_API_KEY: "private-fixture" },
  node: "/fixture/node",
  execute: executeOk,
});
assert.equal(captured.file, "/fixture/node");
assert.deepEqual(captured.args, ["/fixture/iva/scripts/model-config-probe.mjs", "vision"]);
assert.equal(captured.options.env.OLLAMA_API_KEY, "private-fixture");
assert.doesNotMatch(captured.args.join(" "), /private-fixture/, "secrets must stay out of argv");
assert.equal(captured.options.timeout, 30_000);

await assert.rejects(
  runBoundedModelProbe({
    root: "/fixture/iva",
    role: "text",
    env: {},
    execute: (_file, _args, _options, callback) => callback(new Error("headers contained a secret"), "", "private stderr"),
  }),
  (error) => error.message === "text capability probe failed",
  "provider errors must be replaced with a secret-free diagnostic",
);
await assert.rejects(runBoundedModelProbe({ root: "/fixture/iva", role: "other", env: {} }), /invalid/);

console.log("model probe wrapper checks passed: bounded child and sanitized failures");
