/**
 * Proves the bridge's MCP server advertises pi's schemas verbatim and never
 * rejects a correctly named call: pi's own validation is the sole argument gate,
 * so a streamed tool_use with a known name always reaches a blocking handler.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { Doppel } from "../src/doppel.js";
import type { QueryContext } from "../src/query-state.js";
import { MCP_SERVER_NAME } from "../src/skills.js";
import { until } from "./lib/turns.js";

const parameters = Type.Object({
  path: Type.String({ description: "file path" }),
  count: Type.Optional(Type.Number()),
});

const piTool = { name: "read", description: "read a file", parameters } as unknown as Tool;

async function connect(queryCtx: QueryContext) {
  const runtime = createBridgeRuntime({ providerSettings: { systemPromptMode: "claude-code" } });
  const servers = runtime.test.buildMcpServers([piTool], queryCtx);
  const config = servers[MCP_SERVER_NAME] as {
    instance: { connect(transport: unknown): Promise<void> };
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([config.instance.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("MCP tool dispatch", () => {
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
