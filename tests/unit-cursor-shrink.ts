/**
 * The cursor follows pi's history down, not just up.
 *
 * A compaction or a tree rewind leaves pi with fewer messages than the doppel's
 * cursor counted a turn earlier. The cursor once tracked a high-water mark, so it
 * stayed above the shortened history and every later turn planned a rebuild: a
 * fresh Claude Code subprocess, a cold cache, and the whole context re-sent, for
 * as long as it took pi's history to grow back past the old peak.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  Context,
  Model,
  Message as PiMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { planSessionSync } from "doppelclaude/doppel";
import { PushQueue } from "doppelclaude/query-state";
import { convertPiMessages } from "pi-doppelclaude/convert";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
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

function makeRuntime() {
  const runtime = createBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
    queryFactory: () => {
      const queue = new PushQueue<SDKMessage>();
      for (const message of answer("ok")) queue.push(message);
      // Left open, the way the warm host query waits between turns; ending it here would
      // read as the subprocess dying and tear the session down before the assertion.
      const iterate = async function* () {
        for await (const message of queue) yield message;
      };
      return {
        [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
        initializationResult: async () => ({}),
        setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
        setModel: async () => {},
        interrupt: async () => ({}),
        close: () => queue.end(),
      } as unknown as Query;
    },
  });
  void runtime.designateHost(HOST_SESSION);
  return runtime;
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
      session_id: HOST_CC_SESSION,
    },
  ] as unknown as SDKMessage[];
}

function stream(runtime: ReturnType<typeof makeRuntime>, messages: unknown[]) {
  return runtime.stream(
    fakeModel,
    { systemPrompt: "", messages: messages as PiMessage[], tools: [] } as unknown as Context,
    { sessionId: HOST_SESSION } as SimpleStreamOptions,
  );
}

/** What pi holds right after a compaction replaced a long history with a summary. */
const compacted = [
  { role: "user", content: "summary of everything before" },
  { role: "assistant", content: [{ type: "text", text: "understood" }] },
  { role: "user", content: "carry on" },
];

describe("cursor tracking across a shrinking history", () => {
  it("counts a parallel result batch as one Messages user message", async () => {
    const runtime = makeRuntime();
    runtime.test.setHostSession({ sessionId: HOST_CC_SESSION, cursor: 1 });
    const parallelTurn = [
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } },
          { type: "toolCall", id: "call-2", name: "read", arguments: { path: "two" } },
        ],
      },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: "one" },
      { role: "toolResult", toolCallId: "call-2", toolName: "read", content: "two" },
    ];

    await record(stream(runtime, parallelTurn)).done;

    assert.equal(runtime.test.getHostSession().cursor, 3);
  });

  it("lands on the compacted length instead of the pre-compaction peak", async () => {
    const runtime = makeRuntime();
    // The state a long conversation left behind, the moment before pi compacted it.
    runtime.test.setHostSession({ sessionId: HOST_CC_SESSION, cursor: 438 });
    runtime.test.hostContext.latestCursor = 438;

    await record(stream(runtime, compacted)).done;

    assert.equal(runtime.test.getHostSession().cursor, compacted.length);
  });

  it("reuses the session on the turn after a compaction", async () => {
    const runtime = makeRuntime();
    runtime.test.setHostSession({ sessionId: HOST_CC_SESSION, cursor: 438 });
    runtime.test.hostContext.latestCursor = 438;

    await record(stream(runtime, compacted)).done;
    const next = [
      ...compacted,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "and again" },
    ];
    const plan = planSessionSync(
      convertPiMessages(next as PiMessage[])
        .anthropicMessages as unknown as import("@anthropic-ai/sdk/resources").MessageParam[],
      runtime.test.getHostSession(),
    );

    assert.equal(plan.path, "reuse");
  });
});
