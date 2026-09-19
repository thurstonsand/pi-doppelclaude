import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PushQueue } from "doppelclaude/query-state";
import { createHttpServer } from "http-doppelclaude";

const initial =
  "Call the explicitly named echo_token tool exactly once. After its result, reply with exactly that result token.";
const followup = "Repeat the same token exactly.";
const token = "ALPHA_17";
const system =
  "Diagnostic only.\nAmp Thread URL: https://ampcode.com/threads/T-a1111111-1111-4111-8111-111111111111";
const tool = {
  name: "echo_token",
  description: "Return a diagnostic token supplied by the client.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };
const captured: Record<string, Block[]> = { sdk: [], http: [] };
let lane = "sdk";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

// Forward bytes unchanged. Retain bodies only in memory; report hashes and structural checks.
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (request.url?.startsWith("/v1/messages") && !request.url.includes("count_tokens"))
      captured[lane].push(JSON.parse(body.toString()));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (typeof value === "string" && !["host", "content-length", "connection"].includes(name))
        headers.set(name, value);
    const upstream = await fetch(`https://api.anthropic.com${request.url}`, {
      method: request.method,
      headers,
      body: request.method === "POST" ? body : undefined,
    });
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
    response.end();
  } catch (error) {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  }
});
const proxyUrl = await listen(proxy);
const input = new PushQueue<SDKUserMessage>();
const prompt = (content: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  uuid: randomUUID(),
});
const mcp = new McpServer(
  { name: "custom-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
mcp.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: tool.name, description: tool.description, inputSchema: tool.input_schema }],
}));
let sdkCalls = 0;
mcp.setRequestHandler(CallToolRequestSchema, () => {
  sdkCalls++;
  return { content: [{ type: "text", text: token }] };
});
const results: Record<string, unknown> = {};
const sdk = query({
  prompt: input,
  options: {
    model: "claude-opus-5",
    systemPrompt: system,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: proxyUrl,
      ENABLE_TOOL_SEARCH: "false",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
      DISABLE_AUTO_COMPACT: "1",
    },
    mcpServers: { "custom-tools": { type: "sdk", name: "custom-tools", instance: mcp as never } },
  },
});
const sdkResults: unknown[] = [];
try {
  input.push(prompt(initial));
  for await (const message of sdk) {
    if (message.type !== "result") continue;
    sdkResults.push({
      subtype: message.subtype,
      isError: message.is_error,
      ...(message.subtype === "success" ? { text: message.result } : { errors: message.errors }),
    });
    if (message.is_error || message.subtype !== "success" || sdkResults.length === 2) break;
    input.push(prompt(followup));
  }
  results.sdk = { calls: sdkCalls, turns: sdkResults };
} catch (error) {
  results.sdk = {
    calls: sdkCalls,
    turns: sdkResults,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  input.end();
  sdk.close();
}

lane = "http";
let spawns = 0;
const sdkInputs: unknown[] = [];
const key = randomUUID();
const server = createHttpServer({
  apiKey: key,
  supportedModels: [],
  queryFactory(request) {
    spawns++;
    async function* observe() {
      for await (const message of request.prompt) {
        sdkInputs.push({
          contentHash: digest(message.message.content),
          isFollowup: message.message.content === followup,
        });
        yield message;
      }
    }
    return query({
      ...request,
      prompt: observe(),
      options: {
        ...request.options,
        env: { ...request.options?.env, ANTHROPIC_BASE_URL: proxyUrl },
      },
    });
  },
});
const url = await listen(server);
async function turn(messages: Message[]): Promise<Block[]> {
  const response = await fetch(`${url}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 4096,
      stream: true,
      system,
      tools: [tool],
      messages,
    }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200);
  const blocks: Block[] = [];
  let stopped = false;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "error") throw new Error(event.error.message);
    if (event.type === "message_stop") stopped = true;
    if (event.type === "content_block_start") blocks[event.index] = event.content_block;
    if (event.type !== "content_block_delta") continue;
    const block = blocks[event.index];
    const delta = event.delta;
    if (delta.type === "text_delta") block.text = String(block.text ?? "") + delta.text;
    if (delta.type === "thinking_delta")
      block.thinking = String(block.thinking ?? "") + delta.thinking;
    if (delta.type === "signature_delta")
      block.signature = String(block.signature ?? "") + delta.signature;
    if (delta.type === "input_json_delta")
      block.json = String(block.json ?? "") + delta.partial_json;
  }
  assert.ok(stopped, "missing message_stop");
  for (const block of blocks)
    if (block.type === "tool_use") {
      block.input = JSON.parse(String(block.json || "{}"));
      delete block.json;
    }
  return blocks;
}
try {
  const history: Message[] = [{ role: "user", content: initial }];
  const first = await turn(history);
  const call = first.find((block) => block.type === "tool_use");
  assert.equal(call?.name, "echo_token");
  call.id = "client-renamed-1";
  history.push(
    { role: "assistant", content: first },
    { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: token }] },
  );
  const second = await turn(history);
  const answer = second
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(answer, token);
  results.http = { toolAnswer: answer };
  history.push({ role: "assistant", content: second }, { role: "user", content: followup });
  const third = await turn(history);
  const followupAnswer = third
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(followupAnswer, token);
  results.http = {
    toolAnswer: answer,
    followup: followupAnswer,
  };
} catch (error) {
  results.http = {
    ...(results.http as object),
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}
function describe(requests: Block[]) {
  return requests.map((request, index) => {
    const messages = request.messages as Message[];
    const previous = requests[index - 1]?.messages as Message[] | undefined;
    const lastContent = messages.filter((message) => message.role === "user").at(-1)?.content;
    return {
      model: request.model,
      systemHash: digest(request.system),
      toolsHash: digest(request.tools),
      thinking: request.thinking,
      maxTokens: request.max_tokens,
      preservesPreviousMessages: previous
        ? digest(messages.slice(0, previous.length)) === digest(previous)
        : null,
      lastUserIsExactFollowup:
        lastContent === followup ||
        (Array.isArray(lastContent) &&
          lastContent.some((block) => block.type === "text" && block.text === followup)),
      messages: messages.map((message) => ({
        role: message.role,
        blocks:
          typeof message.content === "string"
            ? [{ type: "text", hash: digest(message.content) }]
            : message.content.map((block) => ({
                type: block.type,
                hash: digest(block),
                ...(block.type === "thinking" ? { signatureHash: digest(block.signature) } : {}),
              })),
      })),
    };
  });
}
console.log(
  JSON.stringify(
    {
      results,
      httpSpawns: spawns,
      sdkInputs,
      requests: { sdk: describe(captured.sdk), http: describe(captured.http) },
    },
    null,
    2,
  ),
);
