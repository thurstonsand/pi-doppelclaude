import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type Api,
  type AssistantMessage,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { createCoreResponse } from "doppelclaude/core-response";
import { PushQueue } from "doppelclaude/query-state";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiResponseRuntime } from "pi-doppelclaude/pi-response";
import { createPiBridgeRuntime } from "pi-doppelclaude/pi-runtime";

const [model] = projectCatalogModels(
  [
    {
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      id: "claude-opus-4-6",
      contextWindow: 200_000,
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    } as unknown as Model<Api>,
  ],
  new Set(["claude-opus-4-6"]),
);

async function collect(stream: AsyncIterable<unknown>) {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  for await (const event of stream) events.push(event as (typeof events)[number]);
  return events;
}

function sdkQuery(messages: SDKMessage[]): Query {
  const iterate = async function* () {
    for (const message of messages) yield message;
  };
  return {
    [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
    initializationResult: async () => ({}),
    setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
    setModel: async () => {},
    interrupt: async () => ({}),
    close() {},
  } as unknown as Query;
}

describe("Pi response projection", () => {
  it("starts terminal-only errors before emitting the Pi error", async () => {
    const runtime = createPiResponseRuntime();
    const adapter = runtime.adapt(model);
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.lifecycle = "failed";
    core.record.error = { reason: "error", message: "initialization failed" };
    adapter.native.push({
      type: "terminal_error",
      reason: "error",
      message: "initialization failed",
      response: core.record,
    });
    adapter.native.end();

    const events = await collect(adapter.stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    const error = events[1];
    assert.ok(error);
    assert.equal((error.error as { errorMessage?: string }).errorMessage, "initialization failed");
  });

  it("keeps the requested model as identity and reports a fallback as responseModel", async () => {
    const runtime = createPiResponseRuntime();
    const served = async (servedModel: string) => {
      const adapter = runtime.adapt(model);
      const core = createCoreResponse("command", model.id, new PushQueue());
      core.record.message.stop_reason = "end_turn";
      adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
      core.record.message.model = servedModel;
      adapter.native.push({ type: "response", response: core.record });
      adapter.native.end();
      const done = (await collect(adapter.stream)).find((event) => event.type === "done");
      assert.ok(done);
      return done.message as AssistantMessage;
    };

    const fallback = await served("claude-opus-4-8");
    assert.equal(fallback.model, model.id);
    assert.equal(fallback.responseModel, "claude-opus-4-8");

    const requested = await served(model.id);
    assert.equal(requested.model, model.id);
    assert.equal(requested.responseModel, undefined);
  });

  it("reports a fallback served at message_start on the start partial", async () => {
    const runtime = createPiResponseRuntime();
    const adapter = runtime.adapt(model);
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.message.model = "claude-opus-4-8";
    core.record.message.stop_reason = "end_turn";
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    const iterator = adapter.stream[Symbol.asyncIterator]();
    const start = (await iterator.next()).value;
    assert.ok(start?.type === "start");
    assert.equal(start.partial.model, model.id);
    assert.equal(start.partial.responseModel, "claude-opus-4-8");
    adapter.native.push({ type: "response", response: core.record });
    adapter.native.end();
  });

  it("reports retried, started, and terminal statuses to onResponse", async () => {
    const runtime = createPiResponseRuntime();
    const statuses: number[] = [];
    const adapter = runtime.adapt(model, ({ status, headers }) => {
      assert.deepEqual(headers, {});
      statuses.push(status);
    });
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.message.stop_reason = "end_turn";
    adapter.native.push({ type: "api_retry", status: 529 });
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    adapter.native.push({ type: "api_retry", status: 529 });
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    adapter.native.push({ type: "response", response: core.record });
    adapter.native.end();
    await collect(adapter.stream);
    assert.deepEqual(statuses, [529, 200]);

    const failed: number[] = [];
    const rejected = runtime.adapt(model, ({ status }) => {
      failed.push(status);
    });
    const terminal = createCoreResponse("command", model.id, new PushQueue());
    terminal.record.lifecycle = "failed";
    terminal.record.error = { reason: "error", message: "rate limited" };
    rejected.native.push({
      type: "terminal_error",
      reason: "error",
      message: "rate limited",
      retryableStatus: 429,
      response: terminal.record,
    });
    rejected.native.end();
    await collect(rejected.stream);
    assert.deepEqual(failed, [429]);
  });

  it("fails the stream and aborts the turn when onResponse throws", async () => {
    const runtime = createPiResponseRuntime();
    let aborted = false;
    const adapter = runtime.adapt(
      model,
      () => {
        throw new Error("hook refused");
      },
      () => {
        aborted = true;
      },
    );
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.message.stop_reason = "end_turn";
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    adapter.native.push({ type: "response", response: core.record });
    adapter.native.end();
    const events = await collect(adapter.stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    const error = events[1];
    assert.ok(error);
    assert.equal((error.error as AssistantMessage).errorMessage, "hook refused");
    assert.equal(aborted, true);
  });

  it("settles usage for responses drained after a failure", async () => {
    const runtime = createPiResponseRuntime();
    const adapter = runtime.adapt(model);
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.message.stop_reason = "end_turn";
    adapter.fail(new Error("payload refused"));
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    adapter.native.push({ type: "response", response: core.record });
    adapter.native.end();
    const events = await collect(adapter.stream);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", "error"],
    );
    const failed = events[1]?.error as AssistantMessage;
    runtime.observeUsage(
      {
        commandId: "command",
        requestedModel: model.id,
        responseIds: [core.record.id],
        modelUsage: {
          [model.id]: {
            inputTokens: 1,
            outputTokens: 7,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.5,
            contextWindow: 200_000,
            maxOutputTokens: 1,
          },
        },
      },
      model,
    );
    assert.equal(failed.usage.cost.total, 0.5);
  });

  it("updates tool arguments before emitting toolcall_end", async () => {
    const runtime = createPiResponseRuntime();
    const adapter = runtime.adapt(model);
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.message.stop_reason = "tool_use";
    core.record.message.content = [
      {
        type: "tool_use",
        id: "tool-1",
        name: "read",
        input: { path: "one.txt" },
        caller: { type: "direct" },
      },
    ];
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    adapter.native.push({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "read",
        input: {},
        caller: { type: "direct" },
      },
    });
    for (const partial_json of ['{"path":"one', '.txt"}'])
      adapter.native.push({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json },
      });
    adapter.native.push({ type: "content_block_stop", index: 0 });
    adapter.native.push({ type: "response", response: core.record });
    adapter.native.end();

    const events = await collect(adapter.stream);
    const end = events.find((event) => event.type === "toolcall_end");
    assert.ok(end);
    assert.deepEqual(
      (end.toolCall as { arguments: unknown }).arguments,
      { path: "one.txt" },
      "the terminal tool event must carry the streamed arguments",
    );
  });

  it("filters unsupported blocks without corrupting later content indexes", async () => {
    const runtime = createPiResponseRuntime();
    const adapter = runtime.adapt(model);
    const core = createCoreResponse("command", model.id, new PushQueue());
    core.record.message.stop_reason = "tool_use";
    core.record.message.content = [
      { type: "redacted_thinking", data: "hidden" },
      { type: "text", text: "hello", citations: null },
      {
        type: "tool_use",
        id: "tool-1",
        name: "read",
        input: { path: "a" },
        caller: { type: "direct" },
      },
    ];
    adapter.native.push({ type: "message_start", message: structuredClone(core.record.message) });
    adapter.native.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "hidden" },
    });
    adapter.native.push({ type: "content_block_stop", index: 0 });
    adapter.native.push({
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "", citations: null },
    });
    adapter.native.push({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "hello" },
    });
    adapter.native.push({ type: "content_block_stop", index: 1 });
    adapter.native.push({
      type: "content_block_start",
      index: 2,
      content_block: {
        type: "tool_use",
        id: "tool-1",
        name: "read",
        input: {},
        caller: { type: "direct" },
      },
    });
    adapter.native.push({ type: "content_block_stop", index: 2 });
    adapter.native.push({ type: "response", response: core.record });
    adapter.native.end();

    const events = await collect(adapter.stream);
    assert.deepEqual(
      events.map((event) => [event.type, event.contentIndex]),
      [
        ["start", undefined],
        ["text_start", 0],
        ["text_delta", 0],
        ["text_end", 0],
        ["toolcall_start", 1],
        ["toolcall_end", 1],
        ["done", undefined],
      ],
    );
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (!done) throw new Error("missing done event");
    assert.deepEqual((done.message as { content: unknown[] }).content, [
      { type: "text", text: "hello" },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "a" } },
    ]);
  });

  it("uses requested Pi metadata when fallback usage has only the served raw key", async () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-fallback-b[1m]",
          content: [{ type: "text", text: "answer", citations: null }],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      } as unknown as SDKMessage,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "answer",
        modelUsage: {
          "claude-fallback-b[1m]": {
            inputTokens: 2,
            outputTokens: 3,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.123,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
            canonicalModel: "claude-fallback-b",
            provider: "firstParty",
          },
        },
      } as unknown as SDKMessage,
    ];
    const runtime = createPiBridgeRuntime({
      providerSettings: { systemPromptMode: "claude-code" },
      queryFactory: () => sdkQuery(messages),
    });
    const events = await collect(
      runtime.stream(
        model,
        normalizeContext({
          systemPrompt: "",
          messages: [{ role: "user", content: "hi", timestamp: 1 }],
          tools: [],
        }),
      ),
    );
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (!done) throw new Error("missing done event");
    assert.equal((done.message as { usage: { cost: { total: number } } }).usage.cost.total, 0.123);
  });

  it("emits deltas for complete assistant snapshots and does not duplicate result text", async () => {
    const messages: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: model.id,
          content: [
            { type: "thinking", thinking: "thought", signature: "sig" },
            { type: "text", text: "answer", citations: null },
          ],
        },
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "answer",
        modelUsage: {},
      } as SDKMessage,
    ];
    const runtime = createPiBridgeRuntime({
      providerSettings: { systemPromptMode: "claude-code" },
      queryFactory: () => sdkQuery(messages),
    });
    const events = await collect(
      runtime.stream(
        model,
        normalizeContext({
          systemPrompt: "",
          messages: [{ role: "user", content: "hi", timestamp: 1 }],
          tools: [],
        }),
      ),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "start",
        "thinking_start",
        "thinking_delta",
        "thinking_end",
        "text_start",
        "text_delta",
        "text_end",
        "done",
      ],
    );
    const done = events.at(-1)?.message as { content: unknown[] };
    assert.equal(done.content.length, 2);
  });

  it("forwards pi's maxTokens, as the payload hook leaves it, to Claude Code", async () => {
    const spawnCeilings: Array<string | undefined> = [];
    const runtime = createPiBridgeRuntime({
      providerSettings: { systemPromptMode: "claude-code" },
      queryFactory: ({ options }) => {
        spawnCeilings.push(options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
        return sdkQuery([
          { type: "result", subtype: "success", is_error: false, result: "", modelUsage: {} },
        ] as unknown as SDKMessage[]);
      },
    });
    const context = normalizeContext({
      systemPrompt: "",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [],
    });
    const offered: unknown[] = [];
    await collect(runtime.stream(model, context));
    await collect(
      runtime.stream(model, context, {
        maxTokens: 123,
        onPayload: (payload) => {
          offered.push((payload as { max_tokens?: number }).max_tokens);
          return { ...(payload as object), max_tokens: 99 };
        },
      }),
    );
    assert.deepEqual(offered, [123]);
    assert.deepEqual(spawnCeilings, [undefined, "99"]);
  });
});
