/**
 * A turn Claude Code reports as billed to Extra Usage stops the conversation unless the user
 * opted in. Claude Code reports a changed limit once, after the response that changed it, so a
 * turn already closed on a tool call has to fail when its results come back — answering them
 * would be the next charged request.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpServer } from "http-doppelclaude";

const KEY = "test-key";
const THREAD = "T-22222222-2222-4222-8222-222222222222";

function body(messages: unknown[]) {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    stream: true,
    system: `x\nAmp Thread URL: https://ampcode.com/threads/${THREAD}`,
    tools: [
      {
        name: "lookup",
        description: "lookup",
        input_schema: { type: "object", properties: { n: { type: "number" } } },
      },
    ],
    messages,
  };
}

const OVERAGE = {
  type: "rate_limit_event",
  rate_limit_info: { status: "allowed", rateLimitType: "overage", isUsingOverage: true },
} as unknown as SDKMessage;

const RESULT = {
  type: "result",
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  subtype: "success",
  result: "",
  is_error: false,
  modelUsage: {},
} as unknown as SDKMessage;

function textReply(text: string): SDKMessage[] {
  return [
    { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    {
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} },
    },
    { type: "stream_event", event: { type: "message_stop" } },
  ] as unknown as SDKMessage[];
}

function toolCall(): SDKMessage[] {
  return [
    { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "sdk-1",
          name: "mcp__custom-tools__lookup",
          input: {},
        },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ n: 1 }) },
      },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_stop" } },
  ] as unknown as SDKMessage[];
}

interface Fake {
  closed: boolean;
}

function fakeQuery(fake: Fake, run: () => AsyncGenerator<SDKMessage>): Query {
  return {
    [Symbol.asyncIterator]: run,
    initializationResult: async () => ({}),
    setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
    setModel: async () => {},
    applyFlagSettings: async () => {},
    interrupt: async () => ({}),
    close: () => {
      fake.closed = true;
    },
  } as unknown as Query;
}

async function serve(options: Parameters<typeof createHttpServer>[0]) {
  const server = createHttpServer({ ...options, log: () => {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    async post(value: unknown) {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify(value),
      });
      assert.equal(response.status, 200);
      return response.text();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every prompt answered with text, preceded by the Extra Usage report on the first query. */
function textQueries(fakes: Fake[]) {
  return ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    const fake = { closed: false };
    fakes.push(fake);
    const first = fakes.length === 1;
    return fakeQuery(fake, async function* () {
      for await (const _ of prompt) {
        yield { type: "system", subtype: "init", session_id: "cc-session" } as SDKMessage;
        yield* textReply(first ? "charged" : "fresh");
        if (first) yield OVERAGE;
        yield RESULT;
      }
    });
  };
}

describe("Extra Usage guard", () => {
  it("fails a charged turn without a retry status and starts the next turn fresh", async () => {
    const fakes: Fake[] = [];
    const app = await serve({ apiKey: KEY, supportedModels: [], queryFactory: textQueries(fakes) });
    try {
      const charged = await app.post(body([{ role: "user", content: "go" }]));
      assert.match(charged, /event: error/);
      assert.match(charged, /Claude Code billing: this turn was charged to Extra Usage/);
      assert.doesNotMatch(charged, /overloaded_error|rate_limit_error/);
      // A fresh subprocess reports the limit state again on its first request.
      const next = await app.post(
        body([
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "text", text: "charged" }] },
          { role: "user", content: "again" },
        ]),
      );
      assert.match(next, /fresh/);
      assert.equal(fakes.length, 2);
    } finally {
      await app.close();
    }
  });

  it("lets a charged turn through when Extra Usage is allowed", async () => {
    const fakes: Fake[] = [];
    const app = await serve({
      apiKey: KEY,
      supportedModels: [],
      allowExtraUsage: true,
      queryFactory: textQueries(fakes),
    });
    try {
      const charged = await app.post(body([{ role: "user", content: "go" }]));
      assert.match(charged, /charged/);
      assert.doesNotMatch(charged, /event: error/);
    } finally {
      await app.close();
    }
  });

  it("fails a tool round's results instead of handing them to Claude Code", async () => {
    const fake: Fake = { closed: false };
    let delivered: unknown;
    let killedBeforeRelease = false;
    const app = await serve({
      apiKey: KEY,
      supportedModels: [],
      queryFactory: ({ options }) => {
        const config = options?.mcpServers?.["custom-tools"] as {
          instance: { connect(transport: unknown): Promise<void> };
        };
        return fakeQuery(fake, async function* () {
          const client = new Client({ name: "extra-usage-test", version: "1" });
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await Promise.all([
            config.instance.connect(serverTransport),
            client.connect(clientTransport),
          ]);
          const call = client
            .callTool({
              name: "lookup",
              arguments: { n: 1 },
              _meta: { "claudecode/toolUseId": "sdk-1" },
            })
            .then((result) => {
              delivered = result.content;
              killedBeforeRelease = fake.closed;
            });
          yield* toolCall();
          yield OVERAGE;
          await call;
          yield* textReply("looked up");
          yield RESULT;
        });
      },
    });
    try {
      const first = await app.post(body([{ role: "user", content: "go" }]));
      assert.match(first, /"stop_reason":"tool_use"/);
      const continued = await app.post(
        body([
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "client-1", name: "lookup", input: { n: 1 } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "client-1", content: "PI-RESULT-77" }],
          },
        ]),
      );
      assert.match(continued, /event: error/);
      assert.match(continued, /Claude Code billing/);
      assert.doesNotMatch(continued, /looked up/);
      // Killed before its blocked handler is released, so the release reaches no live request.
      assert.equal(killedBeforeRelease, true);
      assert.doesNotMatch(JSON.stringify(delivered), /PI-RESULT-77/);
    } finally {
      await app.close();
    }
  });
});
