import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";

let requestBody;
const server = createServer((req, res) => {
  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    requestBody = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "красный квадрат" } }] }));
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

process.env.MODEL_PROVIDER = "ollama";
process.env.OLLAMA_API_KEY = "fixture-key";
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
delete process.env.OLLAMA_VISION_MODEL;

try {
  const { providerConfig } = await import("../agent/provider.ts");
  const { describeImageOpenAICompatible } = await import("../agent/lib/vision-openai.mjs");
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;
  const description = await describeImageOpenAICompatible({
    bytes,
    mimeType: "image/png",
    baseURL: providerConfig.baseURL,
    apiKey: providerConfig.apiKey,
    visionModel: providerConfig.visionModel,
    prompt: "describe fixture",
  });

  assert.equal(description, "красный квадрат");
  assert.equal(requestBody.model, "gemma3:12b-cloud");
  assert.equal(requestBody.messages[0].content[1].type, "image_url");
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
} finally {
  server.close();
  await once(server, "close");
}

console.log("vision checks passed");
