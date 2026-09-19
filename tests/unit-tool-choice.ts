/**
 * Pi's compaction asks for a summary with `toolChoice: "none"` and throws outright if the
 * answer contains a tool call, so the bridge has to make the tool call impossible rather
 * than unlikely: no MCP server on the spawned query, and the server pulled off a warm one.
 * Drives the real runtime with a fake SDK query and reads the options it was handed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { McpServerConfig, Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Message as PiMessage,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import { PushQueue } from "doppelclaude/query-state";
import { MCP_SERVER_NAME } from "doppelclaude/skills";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { Type } from "typebox";
import { record } from "./lib/turns.js";

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

const HOST_SESSION = "host-session-id";
const HOST_CC_SESSION = "11111111-1111-4111-8111-111111111111";

const piTool = {
  name: "read",
  description: "read a file",
  parameters: Type.Object({ path: Type.String() }),
} as unknown as Tool;

interface SpawnedQuery {
  options: Options | undefined;
  emit(messages: SDKMessage[]): void;
  /** Every server set pushed at the live query, in order; `{}` is a removal. */
  mcpUpdates: Record<string, McpServerConfig>[];
}

function makeHarness(scripts: Array<{ messages?: SDKMessage[]; stayOpen?: boolean }>) {
  const spawned: SpawnedQuery[] = [];
  const runtime = createBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
    queryFactory: (request) => {
      const script = scripts[spawned.length];
      assert.ok(script, `unexpected query spawn #${spawned.length + 1}`);
      const queue = new PushQueue<SDKMessage>();
      const handle: SpawnedQuery = {
        options: request.options,
        emit(messages) {
          for (const message of messages) queue.push(message);
        },
        mcpUpdates: [],
      };
      spawned.push(handle);
      for (const message of script.messages ?? []) queue.push(message);
      if (!script.stayOpen) queue.end();
      const iterate = async function* () {
        for await (const message of queue) yield message;
      };
      return {
        [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
        initializationResult: async () => ({}),
        setMcpServers: async (servers: Record<string, McpServerConfig>) => {
          handle.mcpUpdates.push(servers);
          const names = Object.keys(servers);
          return { added: names, removed: names.length ? [] : [MCP_SERVER_NAME], errors: {} };
        },
        setModel: async () => {},
        interrupt: async () => ({}),
        close: () => queue.end(),
      } as unknown as Query;
    },
  });
  void runtime.designateHost(HOST_SESSION);
  return { runtime, spawned };
}

function stream(
  runtime: ReturnType<typeof makeHarness>["runtime"],
  messages: unknown[],
  options: SimpleStreamOptions,
) {
  return runtime.stream(
    fakeModel,
    {
      systemPrompt: "",
      messages: messages as PiMessage[],
      tools: [piTool],
    } as unknown as Context,
    options,
  );
}

function answer(text: string): SDKMessage[] {
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
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { type: "stream_event", event: { type: "message_stop" } },
    {
      type: "result",
      subtype: "success",
      result: "",
      is_error: false,
      modelUsage: {},
    },
  ] as unknown as SDKMessage[];
}

function texts(events: AssistantMessageEvent[]) {
  return events.flatMap((event) => (event.type === "text_end" ? [event.content] : []));
}

const firstTurn = [{ role: "user", content: "go" }];
const secondTurn = [
  ...firstTurn,
  { role: "assistant", content: [{ type: "text", text: "first" }] },
  { role: "user", content: "summarize this conversation" },
];

describe("toolChoice", () => {
  it("spawns a query with no MCP server when the caller asks for none", async () => {
    const harness = makeHarness([{ messages: answer("summary") }]);
    const turn = record(
      stream(harness.runtime, firstTurn, { sessionId: HOST_SESSION, toolChoice: "none" }),
    );
    await turn.done;

    assert.deepEqual(texts(turn.events), ["summary"]);
    assert.equal(harness.spawned.length, 1);
    assert.equal(
      harness.spawned[0].options?.mcpServers,
      undefined,
      "a toolChoice:none turn was handed pi's tools anyway",
    );
    assert.deepEqual(harness.spawned[0].options?.tools, [], "Claude Code's own tools were left on");
  });

  for (const toolChoice of [undefined, "auto" as const]) {
    it(`still bridges pi's tools for toolChoice=${toolChoice ?? "undefined"}`, async () => {
      const harness = makeHarness([{ messages: answer("hello") }]);
      await record(stream(harness.runtime, firstTurn, { sessionId: HOST_SESSION, toolChoice }))
        .done;

      const servers = harness.spawned[0].options?.mcpServers;
      assert.ok(servers && MCP_SERVER_NAME in servers, "pi's tools never reached Claude Code");
    });
  }

  it("strips the MCP server off the warm host query instead of reusing it with tools", async () => {
    const harness = makeHarness([{ stayOpen: true, messages: answer("first") }]);
    await record(stream(harness.runtime, firstTurn, { sessionId: HOST_SESSION })).done;
    harness.runtime.test.setHostSession({ sessionId: HOST_CC_SESSION, cursor: 1 });
    assert.ok(harness.spawned[0].options?.mcpServers, "the first turn brought no tools");

    const summary = record(
      stream(harness.runtime, secondTurn, { sessionId: HOST_SESSION, toolChoice: "none" }),
    );
    harness.spawned[0].emit(answer("summary"));
    await summary.done;

    assert.equal(harness.spawned.length, 1, "the toolless turn respawned instead of reconciling");
    assert.deepEqual(
      harness.spawned[0].mcpUpdates,
      [{}],
      "the warm query kept pi's tools through a toolChoice:none turn",
    );
    assert.deepEqual(texts(summary.events), ["summary"]);
  });
});
