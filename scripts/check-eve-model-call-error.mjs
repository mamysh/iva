import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const eveRoot = dirname(require.resolve("eve/package.json"));
const classifierModule = await import(pathToFileURL(join(eveRoot, "dist/src/harness/model-call-error.js")));
const { classifyModelCallError } = classifierModule;

for (const name of [
  "AI_InvalidPromptError",
  "AI_InvalidArgumentError",
  "AI_TypeValidationError",
  "AI_NoSuchToolError",
  "AI_InvalidToolInputError",
  "AI_UnsupportedFunctionalityError",
]) {
  const error = new Error("deterministic prompt failure");
  error.name = name;
  assert.equal(classifyModelCallError(error), "terminal", `${name} must not enter Eve's durable retry loop`);
}

const deterministicCause = new Error("invalid tool payload");
deterministicCause.name = "AI_InvalidToolInputError";
assert.equal(
  classifyModelCallError(new Error("model stream failed", { cause: deterministicCause })),
  "terminal",
  "wrapped deterministic errors must not enter Eve's durable retry loop",
);

const similarlyNamedTransient = new Error("temporary provider failure");
similarlyNamedTransient.name = "ProviderInvalidArgumentRetryableError";
assert.equal(
  classifyModelCallError(similarlyNamedTransient),
  "recoverable",
  "unknown errors must not become terminal from a partial name match",
);

const transient = new Error("temporary provider failure");
Object.assign(transient, { statusCode: 429 });
assert.equal(classifyModelCallError(transient), "retry", "transient provider failures must remain retryable");

console.log("eve model-call error classification: ok");
