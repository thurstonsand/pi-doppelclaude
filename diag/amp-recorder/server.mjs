import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const DIR = "/tmp/amp-recorder";
const LOG = path.join(DIR, "requests.ndjson");
const MAX_BODY = 50 * 1024 * 1024;

fs.mkdirSync(DIR, { recursive: true });

function record(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + "\n");
}

function headerPairs(rawHeaders) {
  const out = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name in out) out[name] = [].concat(out[name], value);
    else out[name] = value;
  }
  return out;
}

function summarize(timestamp, method, url, json) {
  const parts = [timestamp, method, url];
  if (json && Array.isArray(json.messages)) {
    parts.push(`model=${json.model ?? "?"}`);
    parts.push(`stream=${json.stream === true}`);
    parts.push(`messages=${json.messages.length}`);
    parts.push(`tools=${Array.isArray(json.tools) ? json.tools.length : 0}`);
    let thinking = false;
    let signed = false;
    for (const message of json.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking" || block.type === "redacted_thinking") {
          thinking = true;
          if (typeof block.signature === "string" && block.signature.length > 0) signed = true;
        }
      }
    }
    parts.push(`thinking=${thinking}`);
    parts.push(`thinking_signature=${signed}`);
  }
  console.log(parts.join(" "));
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "*");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

const MODELS = {
  data: [
    { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-01-01T00:00:00Z" },
    { type: "model", id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-01-01T00:00:00Z" },
  ],
  has_more: false,
  first_id: "claude-opus-5",
  last_id: "claude-sonnet-5",
};

const REPLY = "recorder: ok";

function messagePayload(model, id) {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function streamMessages(res, body, requestId) {
  const id = `msg_recorder_${crypto.randomBytes(8).toString("hex")}`;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let disconnected = false;
  res.on("close", () => {
    if (res.writableEnded) return;
    disconnected = true;
    console.log("client disconnected");
    record({ timestamp: new Date().toISOString(), marker: "client_disconnected", request_id: requestId });
  });

  const send = (event, data) => {
    if (disconnected || res.writableEnded) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  const lastMsg = Array.isArray(body?.messages) ? body.messages[body.messages.length - 1] : null;
  const lastHasToolResult =
    Array.isArray(lastMsg?.content) && lastMsg.content.some((b) => b?.type === "tool_result");
  const hasShell = Array.isArray(body?.tools) && body.tools.some((t) => t?.name === "shell_command");
  const lastUserText = Array.isArray(lastMsg?.content)
    ? lastMsg.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
    : typeof lastMsg?.content === "string" ? lastMsg.content : "";
  const wantsTask = /delegate/i.test(lastUserText) && Array.isArray(body?.tools) && body.tools.some((t) => t?.name === "Task");
  const callTool = (hasShell || wantsTask) && !lastHasToolResult;
  const toolName = wantsTask ? "Task" : "shell_command";
  const toolInput = wantsTask
    ? { prompt: "Reply with the single word pong.", description: "recorder subagent probe" }
    : { command: "echo recorder-tool-ok" };
  const toolId = `toolu_recorder_${crypto.randomBytes(6).toString("hex")}`;

  const events = [
    ["message_start", { type: "message_start", message: messagePayload(body?.model, id) }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "recorder thinking block" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_recorder_fake_0001" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: callTool ? "recorder: calling shell_command" : REPLY } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ];
  if (callTool) {
    events.push(
      ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: toolId, name: toolName, input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: JSON.stringify(toolInput) } }],
      ["content_block_stop", { type: "content_block_stop", index: 2 }],
    );
  }
  events.push(
    ["message_delta", { type: "message_delta", delta: { stop_reason: callTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { input_tokens: 40, output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }],
  );

  for (const [event, data] of events) {
    if (!send(event, data)) return;
  }
  res.end();
}

function nonStreamingMessage(res, body) {
  const id = `msg_recorder_${crypto.randomBytes(8).toString("hex")}`;
  json(res, 200, {
    ...messagePayload(body?.model, id),
    content: [{ type: "text", text: REPLY }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  });
}

const server = http.createServer((req, res) => {
  const timestamp = new Date().toISOString();
  const requestId = crypto.randomBytes(6).toString("hex");
  const chunks = [];
  let size = 0;
  let overflow = false;

  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      overflow = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("aborted", () => {
    console.log("client disconnected");
    record({ timestamp: new Date().toISOString(), marker: "client_disconnected", request_id: requestId });
  });

  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed = null;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }

    record({
      timestamp,
      request_id: requestId,
      method: req.method,
      url: req.url,
      http_version: req.httpVersion,
      headers: headerPairs(req.rawHeaders),
      raw_headers: req.rawHeaders,
      body: raw,
      json: parsed,
      body_overflow: overflow,
    });
    summarize(timestamp, req.method, req.url, parsed);

    cors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const pathname = new URL(req.url, "http://localhost").pathname;

    if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
      json(res, 200, MODELS);
      return;
    }

    if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
      json(res, 200, { input_tokens: 10 });
      return;
    }

    if (req.method === "POST" && (pathname === "/v1/messages" || pathname === "/messages")) {
      const lastM = Array.isArray(parsed?.messages) ? parsed.messages[parsed.messages.length - 1] : null;
      const lastT = Array.isArray(lastM?.content) ? lastM.content.filter((b) => b?.type === "text").map((b) => b.text).join(" ") : String(lastM?.content ?? "");
      if (/overload/i.test(lastT) && String(req.headers["x-stainless-retry-count"] ?? "0") === "0") {
        console.log("returning 529 overloaded once");
        return json(res, 529, { type: "error", error: { type: "overloaded_error", message: "recorder: synthetic overload" } });
      }
      if (parsed?.stream === true) streamMessages(res, parsed, requestId);
      else nonStreamingMessage(res, parsed);
      return;
    }

    json(res, 200, { ok: true, recorded: true });
  });
});

server.on("clientError", (err, socket) => {
  console.log(`client error: ${err.message}`);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`amp-recorder listening on http://0.0.0.0:${PORT}`);
  console.log(`recording to ${LOG}`);
});
