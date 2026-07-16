import { createServer } from "node:http";

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => part?.text ?? part?.content ?? "").join(" ");
}

function chooseResponse(body, requestIndex) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const transcript = messages.map(messageText).join("\n");
  const latestUser = [...messages].reverse().find((message) => message?.role === "user");
  const prompt = messageText(latestUser);
  const hasToolResult = messages.some((message) => message?.role === "tool");

  if (/Use the tasks tool/i.test(prompt) && !hasToolResult) {
    return {
      kind: "tool",
      id: `call_replica_tasks_${requestIndex}`,
      name: "tasks",
      arguments: JSON.stringify({ action: "add", text: "replica canary task", priority: "high" }),
    };
  }
  if (hasToolResult) return { kind: "text", text: "TASK_OK" };
  if (/What code did I ask you to remember/i.test(prompt)) {
    return { kind: "text", text: transcript.match(/CEDAR-\d+/)?.[0] ?? "MISSING_MARKER" };
  }
  if (/Remember this code/i.test(prompt)) return { kind: "text", text: "REMEMBERED" };
  return { kind: "text", text: "REPLICA_OK" };
}

function completionChunk(delta, finishReason = null) {
  return {
    id: "chatcmpl_iva_replica",
    object: "chat.completion.chunk",
    created: 0,
    model: "iva-replica",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function writeSse(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function streamCompletion(response, selected) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  if (selected.kind === "tool") {
    writeSse(response, completionChunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: selected.id,
        type: "function",
        function: { name: selected.name, arguments: selected.arguments },
      }],
    }));
    writeSse(response, completionChunk({}, "tool_calls"));
  } else {
    writeSse(response, completionChunk({ role: "assistant", content: selected.text }));
    writeSse(response, completionChunk({}, "stop"));
  }
  writeSse(response, {
    id: "chatcmpl_iva_replica",
    object: "chat.completion.chunk",
    created: 0,
    model: "iva-replica",
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
  response.end("data: [DONE]\n\n");
}

function jsonCompletion(response, selected) {
  const message = selected.kind === "tool"
    ? {
        role: "assistant",
        content: null,
        tool_calls: [{ id: selected.id, type: "function", function: { name: selected.name, arguments: selected.arguments } }],
      }
    : { role: "assistant", content: selected.text };
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    id: "chatcmpl_iva_replica",
    object: "chat.completion",
    created: 0,
    model: "iva-replica",
    choices: [{ index: 0, message, finish_reason: selected.kind === "tool" ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  }));
}

export async function startMockOpenAiServer() {
  const requests = [];
  const faults = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end("not found");
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      response.writeHead(400).end("invalid json");
      return;
    }
    requests.push(body);
    const fault = faults.shift();
    if (fault?.delayMs) await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault?.status) {
      response.writeHead(fault.status, { "Content-Type": "application/json", "Retry-After": "0" });
      response.end(JSON.stringify({ error: { message: `synthetic HTTP ${fault.status}`, type: fault.status === 429 ? "rate_limit_exceeded" : "server_error" } }));
      return;
    }
    const selected = chooseResponse(body, requests.length);
    if (body.stream) streamCompletion(response, selected);
    else jsonCompletion(response, selected);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    failNext(status, count = 1) {
      for (let index = 0; index < count; index++) faults.push({ status });
    },
    passNext() { faults.push({}); },
    delayNext(delayMs) { faults.push({ delayMs }); },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
