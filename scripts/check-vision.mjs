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

process.env.MODEL_PROVIDER = "codex";
process.env.CODEX_MODEL = "fixture-text-only-route";
process.env.VISION_PROVIDER = "ollama";
process.env.OLLAMA_API_KEY = "fixture-key";
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${address.port}`;
delete process.env.OLLAMA_VISION_MODEL;

try {
  const { providerName, providerConfig, visionProviderName, visionProviderConfig } = await import("../agent/provider.ts");
  const { describeImageWithProvider } = await import("../agent/lib/vision-provider.mjs");
  assert.equal(providerName, "codex");
  assert.equal(providerConfig.textModel, "fixture-text-only-route");
  assert.equal(visionProviderName, "ollama");
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]).buffer;
  const description = await describeImageWithProvider({
    bytes,
    mimeType: "image/png",
    providerName: visionProviderName,
    providerConfig: visionProviderConfig,
    prompt: "describe fixture",
    maxOutputTokens: 80,
  });

  assert.equal(description, "красный квадрат");
  assert.equal(requestBody.model, "minimax-m3");
  assert.equal(requestBody.max_tokens, 80);
  assert.equal(requestBody.messages[0].content[1].type, "image_url");
  assert.match(requestBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
} finally {
  server.close();
  await once(server, "close");
}

console.log("vision checks passed");
