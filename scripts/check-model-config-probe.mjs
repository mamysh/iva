import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runBoundedModelProbe } from "./lib/model-probe.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requests = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const isToolProbe = Array.isArray(body.tools) && body.tools.some((item) => item.function?.name === "iva_model_probe");
  const message = isToolProbe
    ? {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_model_probe",
          type: "function",
          function: { name: "iva_model_probe", arguments: JSON.stringify({ marker: "IVA-MODEL-PROBE" }) },
        }],
      }
    : { role: "assistant", content: "Дерево на чёрном фоне." };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "chatcmpl_model_probe", object: "chat.completion", created: 0, model: body.model,
    choices: [{ index: 0, message, finish_reason: isToolProbe ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const env = {
  ...process.env,
  MODEL_PROVIDER: "ollama",
  VISION_PROVIDER: "ollama",
  OLLAMA_API_KEY: "fixture-only",
  OLLAMA_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  OLLAMA_MODEL: "fixture-text",
  OLLAMA_VISION_MODEL: "fixture-vision",
};

try {
  await runBoundedModelProbe({ root, role: "text", env });
  await runBoundedModelProbe({ root, role: "vision", env });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "fixture-text");
  assert.equal(requests[0].tool_choice.function.name, "iva_model_probe");
  assert.equal(requests[1].model, "fixture-vision");
  assert.match(requests[1].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
} finally {
  server.close();
  await once(server, "close");
}

console.log("model config probes passed: text tool call and isolated synthetic vision marker");
