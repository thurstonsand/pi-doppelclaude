/**
 * Claude Code-rejected tool calls: every ordering of pi's re-entry against CC's
 * follow-up must reach pi intact, and impossible reconciliations must terminate
 * the turn instead of hanging. Drives the real runtime with a fake SDK query.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Message as PiMessage,
  Tool,
} from "@earendil-works/pi-ai";
import { PushQueue } from "doppelclaude/query-state";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiResponseRuntime } from "pi-doppelclaude/pi-response";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { Type } from "typebox";
import { record, until } from "./lib/turns.js";

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
    } as unknown as Model<Api>,
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
  let pushed = 0;
  let handled = 0;
  // Counted on the far side of the yield: the runtime asks for the next message only once
  // it is done with this one, so handled === pushed means everything the fake said has
  // been acted on.
  const iterate = async function* () {
    for await (const message of queue) {
      yield message;
      handled++;
    }
  };
  const sdkQuery = {
    [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
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
  return {
    runtime,
    push(...messages: SDKMessage[]) {
      for (const message of messages) {
        pushed++;
        queue.push(message);
      }
    },
    drained: () => until(() => handled === pushed, "Claude Code's output to reach the runtime"),
    /** The subprocess exits, which is what releases a turn still waiting on it. */
    close: () => queue.end(),
  };
}

function stream(runtime: ReturnType<typeof makeHarness>["runtime"], messages: unknown[]) {
  return runtime.stream(
    fakeModel,
    {
      systemPrompt: "",
      messages: messages as PiMessage[],
      tools: [bashTool],
    } as Context,
    { sessionId: HOST_SESSION },
  );
}

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
  return events.flatMap((event) =>
    event.type === "toolcall_end" ? [{ id: event.toolCall.id, name: event.toolCall.name }] : [],
  );
}

function texts(events: AssistantMessageEvent[]) {
  return events.flatMap((event) => (event.type === "text_end" ? [event.content] : []));
}

function terminalError(events: AssistantMessageEvent[]) {
  const last = events.at(-1);
  return last?.type === "error" ? last.error.errorMessage : null;
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
    const { push, runtime } = makeHarness();
    const turn = record(stream(runtime, prompt));
    push(...toolUseEvents("call_bad", "bash", '{"command":"ls"}'));
    await turn.done;

    assert.deepEqual(toolCalls(turn.events), [{ id: "call_bad", name: "cc_no_such_tool__bash" }]);
    assert.equal(runtime.test.hostContext.rejectedToolCallIds.has("call_bad"), true);
  });

  it("buffers the correction that arrives before pi re-enters (the incident ordering)", async () => {
    const { push, drained, close, runtime } = makeHarness();
    const first = record(stream(runtime, prompt));
    push(...toolUseEvents("call_bad", "bash", '{"command":"ls"}'));
    await first.done;
    push(
      ccRejection("call_bad"),
      ...toolUseEvents("call_good", "mcp__custom-tools__bash", '{"command":"ls"}'),
    );
    await drained();

    const ctx = runtime.test.hostContext;
    assert.ok(ctx.bufferedSdkMessages.length > 0, "correction must be buffered, not discarded");

    const second = record(stream(runtime, rejectedTurn));
    await second.done;
    assert.deepEqual(toolCalls(second.events), [{ id: "call_good", name: "bash" }]);
    assert.equal(terminalError(second.events), null);
    assert.equal(ctx.bufferedSdkMessages.length, 0);

    // The corrected call now dispatches and blocks on pi, as a healthy call must.
    const handler = runtime.test.createMcpToolHandler("bash", ctx);
    const dispatched = handler(
      { command: "ls" },
      { _meta: { "claudecode/toolUseId": "call_good" } },
    );
    await until(() => ctx.hasPendingToolCall("call_good"), "the corrected call to block on pi");
    const third = record(
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
    close();
    await third.done;
  });

  it("streams the correction live when pi re-enters first (the lucky ordering)", async () => {
    const { push, drained, runtime } = makeHarness();
    const first = record(stream(runtime, prompt));
    push(...toolUseEvents("call_bad", "bash", '{"command":"ls"}'));
    await first.done;
    push(ccRejection("call_bad"));
    await drained();

    const second = record(stream(runtime, rejectedTurn));
    await until(
      () => runtime.test.hostContext.bufferedSdkMessages.length === 0,
      "the buffered rejection to be replayed into the re-entering turn",
    );
    push(...toolUseEvents("call_good", "mcp__custom-tools__bash", '{"command":"ls"}'));
    await second.done;

    assert.deepEqual(toolCalls(second.events), [{ id: "call_good", name: "bash" }]);
    assert.equal(terminalError(second.events), null);
  });

  it("replays a buffered text follow-up and its result in order", async () => {
    const { push, drained, runtime } = makeHarness();
    const first = record(stream(runtime, prompt));
    push(...toolUseEvents("call_bad", "bash", '{"command":"ls"}'));
    await first.done;
    push(ccRejection("call_bad"), ...textEvents("that tool does not exist here"), resultMessage());
    await drained();

    const second = record(stream(runtime, rejectedTurn));
    await second.done;
    assert.deepEqual(texts(second.events), ["that tool does not exist here"]);
    const last = second.events.at(-1);
    assert.equal(last.type, "done");
    if (last.type !== "done") throw new Error("expected a trailing done event");
    assert.equal(last.reason, "stop");
  });

  it("resolves the valid call and drops the rejected one when a message mixes both", async () => {
    const { push, close, runtime } = makeHarness();
    const ctx = runtime.test.hostContext;
    const turn = record(stream(runtime, prompt));
    push({
      type: "stream_event",
      event: { type: "message_start", message: { usage: {} } },
    } as unknown as SDKMessage);
    push({
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
    push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    } as unknown as SDKMessage);
    push({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_bad", name: "bash", input: {} },
      },
    } as unknown as SDKMessage);
    push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    } as unknown as SDKMessage);
    push({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    } as unknown as SDKMessage);
    push({ type: "stream_event", event: { type: "message_stop" } } as unknown as SDKMessage);
    await turn.done;
    assert.deepEqual(toolCalls(turn.events), [
      { id: "call_good", name: "bash" },
      { id: "call_bad", name: "cc_no_such_tool__bash" },
    ]);

    const handler = runtime.test.createMcpToolHandler("bash", ctx);
    const dispatched = handler(
      { command: "ls" },
      { _meta: { "claudecode/toolUseId": "call_good" } },
    );
    await until(() => ctx.hasPendingToolCall("call_good"), "the valid call to block on pi");

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
    assert.equal(terminalError(second.events), null);
    assert.equal(ctx.pendingResults.size, 0);
    close();
    await second.done;
  });

  it("never replays a dead turn's buffer into the next command", async () => {
    const { push, drained, close, runtime } = makeHarness();
    const ctx = runtime.test.hostContext;
    const abort = new AbortController();
    const aborted = record(
      runtime.stream(
        fakeModel,
        {
          systemPrompt: "",
          messages: prompt as PiMessage[],
          tools: [bashTool],
        } as Context,
        { sessionId: HOST_SESSION, signal: abort.signal },
      ),
    );
    push(...toolUseEvents("call_bad", "bash", '{"command":"ls"}'));
    await aborted.done;
    push(...textEvents("orphaned follow-up"));
    await drained();
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
    const projection = createPiResponseRuntime();
    ctx.beginCommand(fakeModel.id, projection.adapt(fakeModel).native);
    assert.equal(ctx.bufferedSdkMessages.length, 0);
    assert.equal(ctx.rejectionWindowOpen, false);

    // Nothing is coming for this turn, so the subprocess exits and the stream is read to
    // its end: whatever it never carried, it never will.
    const second = record(stream(runtime, rejectedTurn));
    close();
    await second.done;
    assert.deepEqual(texts(second.events), []);
    assert.deepEqual(toolCalls(second.events), []);
  });

  it("terminates the turn when pi delivers a result for a call it was never shown", async () => {
    const { push, runtime } = makeHarness();
    const first = record(stream(runtime, prompt));
    push(...toolUseEvents("call_bad", "bash", '{"command":"ls"}'));
    await first.done;

    const second = record(
      stream(runtime, [
        ...rejectedTurn,
        { role: "toolResult", toolCallId: "call_phantom", content: "who asked", isError: false },
      ]),
    );
    await second.done;
    assert.match(terminalError(second.events), /never streamed to pi/);
    // pi's history and Claude Code's transcript have parted ways, so the subprocess must not
    // stay warm to stream the rest of that turn into an unrelated one.
    await until(
      () => runtime.test.hostContext.activeQuery === null,
      "the desynced query to be discarded",
    );
  });

  it("terminates the turn when a handler is still waiting after full delivery", async () => {
    const { push, runtime } = makeHarness();
    const ctx = runtime.test.hostContext;
    const first = record(stream(runtime, prompt));
    push({
      type: "stream_event",
      event: { type: "message_start", message: { usage: {} } },
    } as unknown as SDKMessage);
    push({
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
    push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    } as unknown as SDKMessage);
    push({
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
    push({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    } as unknown as SDKMessage);
    push({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } },
    } as unknown as SDKMessage);
    push({ type: "stream_event", event: { type: "message_stop" } } as unknown as SDKMessage);
    await first.done;

    const handler = runtime.test.createMcpToolHandler("bash", ctx);
    const blocked = handler({ command: "ls" }, { _meta: { "claudecode/toolUseId": "call_good" } });
    await until(() => ctx.hasPendingToolCall("call_good"), "the first call to block on pi");

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
    await second.done;
    assert.match(terminalError(second.events), /still waiting/);
    // The turn that blocked it is over, so the handler is answered. Left hanging, it would
    // hold Claude Code's request open and sit in the MCP server for the life of the process.
    assert.deepEqual((await blocked).content, [
      {
        type: "text",
        text: "Claude bridge: 1 tool handler(s) still waiting after 1 result(s) [call_good]",
      },
    ]);
    await until(
      () => runtime.test.hostContext.activeQuery === null,
      "the desynced query to be discarded",
    );
  });
});
