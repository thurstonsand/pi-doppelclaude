/**
 * Proves the bridge's MCP server advertises pi's schemas verbatim and never
 * rejects a correctly named call: pi's own validation is the sole argument gate,
 * so a streamed tool_use with a known name always reaches a blocking handler.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Api, Context, Model, Tool as PiTool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Doppel } from "doppelclaude/doppel";
import { PushQueue, type QueryContext } from "doppelclaude/query-state";
import { MCP_SERVER_NAME } from "doppelclaude/skills";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { Type } from "typebox";
import { until } from "./lib/turns.js";

const parameters = Type.Object({
  path: Type.String({ description: "file path" }),
  count: Type.Optional(Type.Number()),
});

const nativeTool = {
  name: "read",
  description: "read a file",
  input_schema: parameters,
} as unknown as Tool;

const [fakeModel] = projectCatalogModels(
  [
    {
      id: "claude-haiku-4-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<Api>,
  ],
  new Set(["claude-haiku-4-5"]),
);

async function connect(queryCtx: QueryContext) {
  const runtime = createBridgeRuntime({ providerSettings: { systemPromptMode: "claude-code" } });
  const servers = runtime.test.buildMcpServers([nativeTool], queryCtx);
  const config = servers[MCP_SERVER_NAME] as {
    instance: { connect(transport: unknown): Promise<void> };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP tool dispatch", () => {
  it("keeps Pi tool definitions bare through the adapter and dispatches their bare name", async () => {
    let spawnedOptions: Options | undefined;
    const queue = new PushQueue<SDKMessage>();
    const runtime = createBridgeRuntime({
      providerSettings: { systemPromptMode: "claude-code" },
      queryFactory: (request) => {
        spawnedOptions = request.options;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const message of queue) yield message;
          },
          initializationResult: async () => ({}),
          setMcpServers: async () => ({
            added: [] as string[],
            removed: [] as string[],
            errors: {},
          }),
          setModel: async () => {},
          interrupt: async () => ({}),
          close: () => queue.end(),
        } as unknown as Query;
      },
    });
    const sessionId = "adapter-mcp-dispatch";
    void runtime.designateHost(sessionId);
    runtime.stream(
      fakeModel,
      {
        systemPrompt: "",
        messages: [{ role: "user", content: "read it" }],
        tools: [
          {
            name: "Read",
            description: "read a file",
            parameters,
          } as unknown as PiTool,
        ],
      } as unknown as Context,
      { sessionId },
    );
    await until(() => spawnedOptions !== undefined, "the Pi adapter to spawn its SDK query");

    const config = spawnedOptions?.mcpServers?.[MCP_SERVER_NAME] as {
      instance: { connect(transport: unknown): Promise<void> };
    };
    assert.ok(config, "the spawned query did not receive the MCP server");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "Read");
    assert.deepEqual(tools[0].inputSchema, JSON.parse(JSON.stringify(parameters)));

    const call = client.callTool({
      name: "Read",
      arguments: { path: "README.md" },
      _meta: { "claudecode/toolUseId": "toolu_adapter" },
    });
    await until(
      () => runtime.test.hostContext.hasPendingToolCall("toolu_adapter"),
      "the adapter tool call to reach its pending handler",
    );
    const handledName = runtime.test.hostContext.deliverToolResult("toolu_adapter", {
      content: [{ type: "text", text: "contents" }],
    });
    assert.equal(handledName, "Read");
    await call;
    await client.close();
    await runtime.clear("test complete");
  });

  it("advertises pi's TypeBox schema verbatim", async () => {
    const client = await connect(new Doppel("test-doppel", "guest").context);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "read");
    assert.equal(tools[0].description, "read a file");
    assert.deepEqual(tools[0].inputSchema, JSON.parse(JSON.stringify(parameters)));
    await client.close();
  });

  it("dispatches arguments pi would reject instead of validating them away", async () => {
    const queryCtx = new Doppel("test-doppel", "guest").context;
    const client = await connect(queryCtx);
    const call = client.callTool({
      name: "read",
      arguments: { path: 42, extra: "kept" },
      _meta: { "claudecode/toolUseId": "toolu_bad_args" },
    });
    // The handler blocks until pi answers, which is the backpressure the
    // generator needs; wait for it to register rather than awaiting the call.
    await until(
      () => queryCtx.hasPendingToolCall("toolu_bad_args"),
      "the malformed call to reach a waiting handler",
    );
    const answered = queryCtx.deliverToolResult("toolu_bad_args", {
      content: [{ type: "text", text: "Invalid arguments: path must be a string" }],
      isError: true,
    });
    assert.equal(answered, "read", "the waiting handler was registered under another tool");
    const result = await call;
    assert.deepEqual(result.content, [
      { type: "text", text: "Invalid arguments: path must be a string" },
    ]);
    await client.close();
  });

  it("rejects a tool name it never registered", async () => {
    const client = await connect(new Doppel("test-doppel", "guest").context);
    await assert.rejects(
      client.callTool({
        name: "nope",
        arguments: {},
        _meta: { "claudecode/toolUseId": "toolu_x" },
      }),
      /Tool nope not found/,
    );
    await client.close();
  });
});
