/**
 * The output ceiling is a sampling parameter, not a configuration: Amp's compaction lowers
 * `max_tokens` for the summary request and raises it back for the compacted thread, and a
 * respawn for either would forfeit the cached prompt prefix. Drives the HTTP frontend through
 * the real core with a fake SDK query that records the flag-settings control requests.
 *
 * A reply the model stops at the ceiling ends there. Claude Code would otherwise ask the model
 * to carry on, up to three more API requests the client never asked for; the query is retired
 * before the first of those, and the next request rebuilds.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpServer } from "http-doppelclaude";

const KEY = "test-key";
const THREAD = "T-11111111-1111-4111-8111-111111111111";

function body(messages: unknown[], maxTokens: number) {
  return {
    model: "claude-haiku-4-5",
    max_tokens: maxTokens,
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

/** Claude Code names its session on the first prompt; a session is what a warm query resumes. */
function init(options: { resume?: string } | undefined): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: options?.resume ?? "cc-session",
  } as unknown as SDKMessage;
}

function textReply(text: string, stop: "end_turn" | "max_tokens"): SDKMessage[] {
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
      event: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 7 } },
    },
    { type: "stream_event", event: { type: "message_stop" } },
  ] as unknown as SDKMessage[];
}

const RESULT = {
  type: "result",
  subtype: "success",
  result: "",
  is_error: false,
  modelUsage: {},
} as unknown as SDKMessage;

interface FakeQuery {
  spawnCeiling: string | undefined;
  applied: unknown[];
  closed: boolean;
}

/** A query that answers every prompt with `text`, the way the persistent host query does. */
function replyingQuery(text: string) {
  const fakes: FakeQuery[] = [];
  const queryFactory = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<unknown>;
    options?: { env?: Record<string, string>; resume?: string };
  }) => {
    const fake: FakeQuery = {
      spawnCeiling: options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
      applied: [],
      closed: false,
    };
    fakes.push(fake);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const _ of prompt) {
          yield init(options);
          yield* textReply(text, "end_turn");
          yield RESULT;
        }
      },
      initializationResult: async () => ({}),
      setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
      setModel: async () => {},
      applyFlagSettings: async (settings: unknown) => {
        fake.applied.push(settings);
      },
      interrupt: async () => ({}),
      close: () => {
        fake.closed = true;
      },
    } as unknown as Query;
  };
  return { fakes, queryFactory };
}

async function serve(options: Parameters<typeof createHttpServer>[0]) {
  const logs: Array<Record<string, unknown>> = [];
  const server = createHttpServer({ ...options, log: (record) => logs.push(record) });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    logs,
    completed: () => logs.filter((record) => record.event === "request_complete"),
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

function executionEvents(record: Record<string, unknown>): string[] {
  return (record.executions as Array<{ event: string }>)
    .map((execution) => execution.event)
    .filter((event) => event !== "sdk_result");
}

describe("output ceiling", () => {
  it("moves the ceiling on the live query only when it changes, without a respawn", async () => {
    const { fakes, queryFactory } = replyingQuery("ok");
    const app = await serve({ apiKey: KEY, supportedModels: [], queryFactory });
    try {
      const history: unknown[] = [{ role: "user", content: "go" }];
      // Amp's compaction: the thread at 32000, the summary at 16384, the compacted thread at
      // 32000 again — with one unchanged request in between, which must not touch the query.
      for (const ceiling of [32_000, 16_384, 16_384, 32_000]) {
        assert.match(await app.post(body(history, ceiling)), /ok/);
        history.push(
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: `again ${ceiling}` },
        );
      }
      assert.equal(fakes.length, 1);
      assert.equal(fakes[0].spawnCeiling, "32000");
      assert.deepEqual(fakes[0].applied, [
        { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384" } },
        { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" } },
      ]);
      const completed = app.completed();
      assert.deepEqual(
        completed.map((record) => record.reason),
        ["first_request", "compatible", "compatible", "compatible"],
      );
      assert.deepEqual(completed.map(executionEvents), [
        ["query_created"],
        ["query_reused"],
        ["query_reused"],
        ["query_reused"],
      ]);
      assert.deepEqual(
        completed.map((record) => record.maxTokens),
        [32_000, 16_384, 16_384, 32_000],
      );
    } finally {
      await app.close();
    }
  });

  it("moves the ceiling before a tool result continues the blocked turn", async () => {
    const fake: FakeQuery = { spawnCeiling: undefined, applied: [], closed: false };
    let spawns = 0;
    const appliedBeforeResult: unknown[][] = [];
    const app = await serve({
      apiKey: KEY,
      supportedModels: [],
      queryFactory: ({ options }) => {
        spawns++;
        fake.spawnCeiling = options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
        const config = options?.mcpServers?.["custom-tools"] as {
          instance: { connect(transport: unknown): Promise<void> };
        };
        return {
          async *[Symbol.asyncIterator]() {
            const client = new Client({ name: "ceiling-test", version: "1" });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await Promise.all([
              config.instance.connect(serverTransport),
              client.connect(clientTransport),
            ]);
            try {
              const result = client.callTool({
                name: "lookup",
                arguments: { n: 1 },
                _meta: { "claudecode/toolUseId": "sdk-1" },
              });
              yield* [
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
              await result;
              // What Claude Code's next API request would carry: the ceiling as of the moment
              // the tool result unblocked it.
              appliedBeforeResult.push([...fake.applied]);
              yield* textReply("looked up", "end_turn");
              yield RESULT;
            } finally {
              await client.close();
            }
          },
          initializationResult: async () => ({}),
          setMcpServers: async () => ({
            added: [] as string[],
            removed: [] as string[],
            errors: {},
          }),
          setModel: async () => {},
          applyFlagSettings: async (settings: unknown) => {
            fake.applied.push(settings);
          },
          interrupt: async () => ({}),
          close: () => {
            fake.closed = true;
          },
        } as unknown as Query;
      },
    });
    try {
      const first = await app.post(body([{ role: "user", content: "go" }], 32_000));
      assert.match(first, /"stop_reason":"tool_use"/);
      const continued = await app.post(
        body(
          [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "client-1", name: "lookup", input: { n: 1 } }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "client-1", content: "one" }],
            },
          ],
          16_384,
        ),
      );
      assert.match(continued, /looked up/);
      assert.equal(spawns, 1);
      assert.equal(fake.spawnCeiling, "32000");
      assert.deepEqual(appliedBeforeResult, [
        [{ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16384" } }],
      ]);
      const completed = app.completed();
      assert.deepEqual(
        completed.map((record) => record.reason),
        ["first_request", "compatible"],
      );
      assert.deepEqual(executionEvents(completed[1]), ["tool_result_continuation"]);
    } finally {
      await app.close();
    }
  });

  it("ends the reply at the ceiling and retires the query before Claude Code continues", async () => {
    const fakes: FakeQuery[] = [];
    let prompts = 0;
    const app = await serve({
      apiKey: KEY,
      supportedModels: [],
      queryFactory: ({ prompt, options }) => {
        const fake: FakeQuery = {
          spawnCeiling: options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
          applied: [],
          closed: false,
        };
        fakes.push(fake);
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _ of prompt) {
              prompts++;
              yield init(options);
              if (fakes.length === 1) {
                yield* textReply("first half", "max_tokens");
                // Claude Code's max-output-tokens recovery: a second API request the client
                // never made, already on the wire before the close lands.
                yield* textReply(" second half", "end_turn");
                yield RESULT;
              } else {
                yield* textReply("fresh", "end_turn");
                yield RESULT;
              }
            }
          },
          initializationResult: async () => ({}),
          setMcpServers: async () => ({
            added: [] as string[],
            removed: [] as string[],
            errors: {},
          }),
          setModel: async () => {},
          applyFlagSettings: async () => {},
          interrupt: async () => ({}),
          close: () => {
            fake.closed = true;
          },
        } as unknown as Query;
      },
    });
    try {
      const truncated = await app.post(body([{ role: "user", content: "go" }], 64));
      assert.match(truncated, /first half/);
      assert.doesNotMatch(truncated, /second half/);
      assert.match(truncated, /"stop_reason":"max_tokens"/);
      assert.match(truncated, /event: message_stop/);
      assert.doesNotMatch(truncated, /event: error/);
      assert.equal(fakes[0].closed, true);
      const next = await app.post(
        body(
          [
            { role: "user", content: "go" },
            { role: "assistant", content: [{ type: "text", text: "first half" }] },
            { role: "user", content: "continue" },
          ],
          64,
        ),
      );
      assert.match(next, /fresh/);
      assert.equal(fakes.length, 2);
      assert.equal(prompts, 2);
      const completed = app.completed();
      assert.deepEqual(
        completed.map((record) => record.outcome),
        ["success", "success"],
      );
      assert.deepEqual(completed.map(executionEvents), [["query_created"], ["query_created"]]);
      // Not a missing session: the retired query's, forced aside by the ceiling stop.
      const rebuilt = (completed[1].executions as Array<{ syncReason?: string }>)[0];
      assert.equal(rebuilt.syncReason, "forced");
    } finally {
      await app.close();
    }
  });
});
