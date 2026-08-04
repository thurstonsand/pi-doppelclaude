/**
 * Claude Code-rejected tool calls: every ordering of pi's re-entry against CC's
 * follow-up must reach pi intact, and impossible reconciliations must terminate
 * the turn instead of hanging. Drives the real runtime with a fake SDK query.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AssistantMessageEvent,
  Context,
  Model,
  Message as PiMessage,
  Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { projectCatalogModels } from "../src/models.js";
import { PushQueue } from "../src/query-state.js";

// Only a catalog-confirmed model reaches the query path, so mint one the way the
// provider does instead of hand-rolling a stand-in.
const [fakeModel] = projectCatalogModels(
  [
    {
      id: "claude-haiku-4-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<any>,
  ],
  new Set(["claude-haiku-4-5"]),
);

const bashTool = {
  name: "bash",
  description: "run a command",
  parameters: Type.Object({ command: Type.String() }),
} as unknown as Tool;

/** These turns are the host conversation's, so the runtime is told the host is this caller. */
const HOST_SESSION = "host-session-id";

function makeHarness() {
  const queue = new PushQueue<SDKMessage>();
  const sdkQuery = {
    [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
    initializationResult: async () => ({}),
    setMcpServers: async () => ({}),
    interrupt: async () => ({}),
    close: () => queue.end(),
  } as unknown as Query;
  const runtime = createBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
    queryFactory: () => sdkQuery,
  });
  void runtime.designateHost(HOST_SESSION);
  return { queue, runtime };
}

function stream(runtime: ReturnType<typeof makeHarness>["runtime"], messages: unknown[]) {
  return runtime.test.streamClaudeAgentSdk(
    fakeModel,
    {
      systemPrompt: "",
      messages: messages as PiMessage[],
      tools: [bashTool],
    } as Context,
    { sessionId: HOST_SESSION },
  );
}

// Collect events without waiting for the stream to end; the tool-use turns end
// their pi stream, and the tests assert on what arrived so far.
function record(source: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  void (async () => {
    for await (const event of source) events.push(event);
  })();
  return events;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function toolUseEvents(id: string, name: string, args: string): SDKMessage[] {
  return [
    { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name, input: {} },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: args },
      },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } },
    { type: "stream_event", event: { type: "message_stop" } },
  ] as unknown as SDKMessage[];
}

function textEvents(text: string): SDKMessage[] {
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
  ] as unknown as SDKMessage[];
}

// Claude Code's synthesized answer for a call it declined to dispatch.
function ccRejection(id: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content: "No such tool available", is_error: true },
      ],
    },
  } as unknown as SDKMessage;
}

function resultMessage(): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "",
    is_error: false,
    modelUsage: {},
  } as unknown as SDKMessage;
}

function toolCalls(events: AssistantMessageEvent[]) {
  return events
    .filter((event) => event.type === "toolcall_end")
    .map((event: any) => ({ id: event.toolCall.id, name: event.toolCall.name }));
}

function texts(events: AssistantMessageEvent[]) {
  return events.filter((event) => event.type === "text_end").map((event: any) => event.content);
}

function terminalError(events: AssistantMessageEvent[]) {
  const last = events.at(-1);
  return last?.type === "error" ? (last as any).error.errorMessage : null;
}

const prompt = [{ role: "user", content: "go" }];
const rejectedTurn = [
  ...prompt,
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_bad",
        name: "cc_no_such_tool__bash",
        arguments: { command: "ls" },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call_bad",
    content: "Tool cc_no_such_tool__bash not found",
    isError: true,
  },
];

describe("Claude Code-rejected tool calls", () => {
  it("streams a rejected name to pi under the marker and never maps a real pi tool", async () => {
    const { queue, runtime } = makeHarness();
    const events = record(stream(runtime, prompt));
    await tick();
    for (const message of toolUseEvents("call_bad", "bash", '{"command":"ls"}'))
      queue.push(message);
    await tick();

    assert.deepEqual(toolCalls(events), [{ id: "call_bad", name: "cc_no_such_tool__bash" }]);
    assert.equal(runtime.test.hostContext.rejectedToolCallIds.has("call_bad"), true);
  });

  it("buffers the correction that arrives before pi re-enters (the incident ordering)", async () => {
    const { queue, runtime } = makeHarness();
    record(stream(runtime, prompt));
    await tick();
    for (const message of toolUseEvents("call_bad", "bash", '{"command":"ls"}'))
      queue.push(message);
    queue.push(ccRejection("call_bad"));
    for (const message of toolUseEvents("call_good", "mcp__custom-tools__bash", '{"command":"ls"}'))
      queue.push(message);
    await tick();

    const ctx = runtime.test.hostContext;
    assert.ok(ctx.bufferedSdkMessages.length > 0, "correction must be buffered, not discarded");

    const second = record(stream(runtime, rejectedTurn));
    await tick();
    assert.deepEqual(toolCalls(second), [{ id: "call_good", name: "bash" }]);
    assert.equal(terminalError(second), null);
    assert.equal(ctx.bufferedSdkMessages.length, 0);

    // The corrected call now dispatches and blocks on pi, as a healthy call must.
    const handler = runtime.test.createMcpToolHandler("bash", ctx);
    const dispatched = handler(
      { command: "ls" },
      { _meta: { "claudecode/toolUseId": "call_good" } },
    );
    await tick();
    assert.equal(ctx.pendingToolCalls.has("call_good"), true);
    record(
      stream(runtime, [
        ...rejectedTurn,
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_good", name: "bash", arguments: { command: "ls" } },
          ],
        },
        { role: "toolResult", toolCallId: "call_good", content: "file.txt" },
      ]),
    );
    assert.deepEqual((await dispatched).content, [{ type: "text", text: "file.txt" }]);
  });

  it("streams the correction live when pi re-enters first (the lucky ordering)", async () => {
    const { queue, runtime } = makeHarness();
    record(stream(runtime, prompt));
    await tick();
    for (const message of toolUseEvents("call_bad", "bash", '{"command":"ls"}'))
      queue.push(message);
    queue.push(ccRejection("call_bad"));
    await tick();

    const second = record(stream(runtime, rejectedTurn));
    await tick();
    assert.equal(runtime.test.hostContext.bufferedSdkMessages.length, 0);
    for (const message of toolUseEvents("call_good", "mcp__custom-tools__bash", '{"command":"ls"}'))
      queue.push(message);
    await tick();

    assert.deepEqual(toolCalls(second), [{ id: "call_good", name: "bash" }]);
    assert.equal(terminalError(second), null);
  });

  it("replays a buffered text follow-up and its result in order", async () => {
    const { queue, runtime } = makeHarness();
    record(stream(runtime, prompt));
    await tick();
    for (const message of toolUseEvents("call_bad", "bash", '{"command":"ls"}'))
      queue.push(message);
    queue.push(ccRejection("call_bad"));
    for (const message of textEvents("that tool does not exist here")) queue.push(message);
    queue.push(resultMessage());
    await tick();

    const second = record(stream(runtime, rejectedTurn));
    await tick();
    assert.deepEqual(texts(second), ["that tool does not exist here"]);
    assert.equal(second.at(-1)?.type, "done");
    assert.equal((second.at(-1) as any).reason, "stop");
  });

  it("resolves the valid call and drops the rejected one when a message mixes both", async () => {
    const { queue, runtime } = makeHarness();
    const ctx = runtime.test.hostContext;
    const events = record(stream(runtime, prompt));
    await tick();
    queue.push({
      type: "stream_event",
      event: { type: "message_start", message: { usage: {} } },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_good",
          name: "mcp__custom-tools__bash",
          input: {},
        },
      },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_bad", name: "bash", input: {} },
      },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    } as unknown as SDKMessage);
    queue.push({ type: "stream_event", event: { type: "message_stop" } } as unknown as SDKMessage);
    await tick();
    assert.deepEqual(toolCalls(events), [
      { id: "call_good", name: "bash" },
      { id: "call_bad", name: "cc_no_such_tool__bash" },
    ]);

    const handler = runtime.test.createMcpToolHandler("bash", ctx);
    const dispatched = handler(
      { command: "ls" },
      { _meta: { "claudecode/toolUseId": "call_good" } },
    );
    await tick();

    const second = record(
      stream(runtime, [
        ...prompt,
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_good", name: "bash", arguments: { command: "ls" } },
            {
              type: "toolCall",
              id: "call_bad",
              name: "cc_no_such_tool__bash",
              arguments: { command: "ls" },
            },
          ],
        },
        { role: "toolResult", toolCallId: "call_good", content: "file.txt" },
        {
          role: "toolResult",
          toolCallId: "call_bad",
          content: "Tool cc_no_such_tool__bash not found",
          isError: true,
        },
      ]),
    );
    assert.deepEqual((await dispatched).content, [{ type: "text", text: "file.txt" }]);
    assert.equal(terminalError(second), null);
    assert.equal(ctx.pendingResults.size, 0);
  });

  it("never replays a dead turn's buffer into the next command", async () => {
    const { queue, runtime } = makeHarness();
    const ctx = runtime.test.hostContext;
    const abort = new AbortController();
    record(
      runtime.test.streamClaudeAgentSdk(
        fakeModel,
        {
          systemPrompt: "",
          messages: prompt as PiMessage[],
          tools: [bashTool],
        } as Context,
        { sessionId: HOST_SESSION, signal: abort.signal },
      ),
    );
    await tick();
    for (const message of toolUseEvents("call_bad", "bash", '{"command":"ls"}'))
      queue.push(message);
    for (const message of textEvents("orphaned follow-up")) queue.push(message);
    await tick();
    assert.ok(ctx.bufferedSdkMessages.length > 0, "expected an open window holding the follow-up");

    // The abort kills the turn, so its buffer dies with it — asserted synchronously,
    // before the interrupt settles and a close path could clear it instead.
    abort.abort();
    assert.equal(ctx.bufferedSdkMessages.length, 0);
    assert.equal(ctx.rejectionWindowOpen, false);

    // A reused query starts its next command here; a buffer that survived this
    // boundary would replay a dead turn's content into an unrelated one.
    ctx.bufferedSdkMessages = [...textEvents("stale content")];
    ctx.rejectionWindowOpen = true;
    ctx.beginCommand(fakeModel);
    assert.equal(ctx.bufferedSdkMessages.length, 0);
    assert.equal(ctx.rejectionWindowOpen, false);

    const second = record(stream(runtime, rejectedTurn));
    await tick();
    assert.deepEqual(texts(second), []);
    assert.deepEqual(toolCalls(second), []);
  });

  it("terminates the turn when pi delivers a result for a call it was never shown", async () => {
    const { queue, runtime } = makeHarness();
    record(stream(runtime, prompt));
    await tick();
    for (const message of toolUseEvents("call_bad", "bash", '{"command":"ls"}'))
      queue.push(message);
    await tick();

    const second = record(
      stream(runtime, [
        ...rejectedTurn,
        { role: "toolResult", toolCallId: "call_phantom", content: "who asked", isError: false },
      ]),
    );
    await tick();
    assert.match(terminalError(second), /never streamed to pi/);
  });

  it("terminates the turn when a handler is still waiting after full delivery", async () => {
    const { queue, runtime } = makeHarness();
    const ctx = runtime.test.hostContext;
    record(stream(runtime, prompt));
    await tick();
    queue.push({
      type: "stream_event",
      event: { type: "message_start", message: { usage: {} } },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "call_good",
          name: "mcp__custom-tools__bash",
          input: {},
        },
      },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "call_other",
          name: "mcp__custom-tools__bash",
          input: {},
        },
      },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    } as unknown as SDKMessage);
    queue.push({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    } as unknown as SDKMessage);
    queue.push({ type: "stream_event", event: { type: "message_stop" } } as unknown as SDKMessage);
    await tick();

    const handler = runtime.test.createMcpToolHandler("bash", ctx);
    void handler({ command: "ls" }, { _meta: { "claudecode/toolUseId": "call_good" } });
    await tick();

    // pi answers only the second call, leaving the first handler blocked.
    const second = record(
      stream(runtime, [
        ...prompt,
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_good", name: "bash", arguments: { command: "ls" } },
            { type: "toolCall", id: "call_other", name: "bash", arguments: { command: "ls" } },
          ],
        },
        { role: "toolResult", toolCallId: "call_other", content: "unrelated" },
      ]),
    );
    await tick();
    assert.match(terminalError(second), /still waiting/);
  });
});
