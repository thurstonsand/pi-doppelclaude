import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime as createCoreBridgeRuntime } from "doppelclaude/bridge-runtime";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import { Doppel } from "doppelclaude/doppel";
import { PushQueue } from "doppelclaude/query-state";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { beginProjectedCommand } from "./lib/native-response.js";

const runtime = createBridgeRuntime({
  providerSettings: { systemPromptMode: "claude-code" },
});

// Minimal stand-in for pi-ai's Model; the stream path only reads api/provider/id/cost.
const fakeModel = {
  api: "doppelclaude",
  provider: "doppelclaude",
  id: "claude-test",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;

async function collect(stream: AssistantMessageEventStream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("provider SDK result errors", () => {
  it("ends with a pi error event and preserves the SDK message verbatim", async () => {
    const message = "prompt is too long: 213462 tokens > 200000 maximum";
    const sdkQuery = (async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        errors: [message],
        modelUsage: {},
      };
    })();
    const queryCtx = new Doppel("test-doppel", "guest").context;
    const stream = beginProjectedCommand(queryCtx, fakeModel);

    await runtime.test.consumeQuery(
      sdkQuery as unknown as Query,
      new Map(),
      fakeModel.id,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );
    runtime.test.finalizeCurrentResponse(queryCtx);

    const events = await collect(stream);
    const last = events.at(-1);
    assert.equal(last.type, "error");
    if (last.type !== "error") throw new Error("expected a trailing error event");
    assert.equal(last.reason, "error");
    assert.equal(last.error.stopReason, "error");
    assert.equal(last.error.errorMessage, message);
  });

  // A revoked OAuth token was reported three times: a bogus served-model warning for the
  // `<synthetic>` marker, the error envelope as assistant text, and a terminal error that
  // read "Claude Code failed: success". One failure, one report.
  it("reports a synthetic error envelope once, as the turn's error", async () => {
    const notifications: string[] = [];
    const failure = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
    runtime.setHost({
      ui: { notify: (text: string) => notifications.push(text) } as unknown as ExtensionUIContext,
      appendEntry() {},
    });

    const sdkQuery = (async function* () {
      yield {
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [{ type: "text", text: failure }],
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        terminal_reason: "completed",
        result: failure,
        modelUsage: {
          "<synthetic>": {
            inputTokens: 0,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 0,
            maxOutputTokens: 0,
          },
        },
      };
    })();
    const queryCtx = new Doppel("test-doppel", "guest").context;
    const stream = beginProjectedCommand(queryCtx, fakeModel);

    await runtime.test.consumeQuery(
      sdkQuery as unknown as Query,
      new Map(),
      fakeModel.id,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );
    runtime.test.finalizeCurrentResponse(queryCtx);

    const events = await collect(stream);
    const last = events.at(-1);
    assert.equal(last.type, "error");
    if (last.type !== "error") throw new Error("expected a trailing error event");
    // A revoked credential also carries the only instruction that can fix it.
    assert.equal(
      last.error.errorMessage,
      `${failure} — usually a transient credential-refresh race; sending the message again typically works. If it persists, run \`claude /login\`.`,
    );
    assert.deepEqual(last.error.content, [], "the envelope must not enter the transcript");
    assert.deepEqual(notifications, [], "a fabricated message is not a served model");
  });
});

// The stream carries Claude's own terminal reason. Treating an unrecognized one as a
// clean stop commits a refused or truncated answer as if the model had finished, so
// every reason is named and anything else fails loudly.
describe("provider stop reasons", () => {
  const streamEvent = (event: unknown) => ({ type: "stream_event", event });

  function turn(stopReason: string | undefined, options: { withResult?: boolean } = {}) {
    const messages: unknown[] = [
      streamEvent({ type: "message_start", message: { model: "claude-test", usage: {} } }),
      streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "partial" },
      }),
      streamEvent({ type: "content_block_stop", index: 0 }),
    ];
    if (stopReason !== undefined) {
      messages.push(streamEvent({ type: "message_delta", delta: { stop_reason: stopReason } }));
    }
    if (options.withResult !== false) {
      messages.push({
        type: "result",
        subtype: "success",
        result: "partial",
        is_error: false,
        modelUsage: {},
      });
    }
    return messages;
  }

  async function runTurn(messages: unknown[]) {
    const sdkQuery = (async function* () {
      for (const message of messages) yield message;
    })();
    const queryCtx = new Doppel("test-doppel", "guest").context;
    const stream = beginProjectedCommand(queryCtx, fakeModel);

    await runtime.test.consumeQuery(
      sdkQuery as unknown as Query,
      new Map(),
      fakeModel.id,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );
    runtime.test.finalizeCurrentResponse(queryCtx);

    const events = await collect(stream);
    return events.at(-1);
  }

  for (const [reason, expected] of [
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["pause_turn", "stop"],
    ["max_tokens", "length"],
  ] as const) {
    it(`completes a turn that stopped with ${reason}`, async () => {
      const last = await runTurn(turn(reason));
      assert.equal(last.type, "done");
      if (last.type !== "done") throw new Error("expected a trailing done event");
      assert.equal(last.message.stopReason, expected);
      assert.equal(
        last.message.rawStopReason,
        reason,
        "Claude's own wording survives for diagnostics",
      );
    });
  }

  for (const reason of [
    "refusal",
    "model_context_window_exceeded",
    "a_reason_anthropic_has_not_shipped_yet",
  ]) {
    it(`fails the turn when Claude stopped with ${reason}`, async () => {
      const last = await runTurn(turn(reason));
      assert.equal(last.type, "error", `${reason} must not be reported as a completed turn`);
      if (last.type !== "error") throw new Error("expected a trailing error event");
      assert.equal(last.error.stopReason, "error");
      assert.equal(last.error.rawStopReason, reason);
    });
  }

  it("fails a turn whose stream ended without any terminal reason", async () => {
    const last = await runTurn(turn(undefined, { withResult: false }));
    assert.equal(last.type, "error", "a truncated stream must not commit its partial output");
    if (last.type !== "error") throw new Error("expected a trailing error event");
    assert.equal(last.error.stopReason, "error");
  });

  // Legs that never stream a `message_delta` — partial messages off, or a bare result
  // carrying the text — are completed by the SDK result instead.
  it("completes a turn whose only terminal signal is the SDK result", async () => {
    const last = await runTurn([
      { type: "result", subtype: "success", result: "answered", is_error: false, modelUsage: {} },
    ]);
    assert.equal(last.type, "done");
    if (last.type !== "done") throw new Error("expected a trailing done event");
    assert.equal(last.message.stopReason, "stop");
  });
});

describe("native response completion", () => {
  const coreRuntime = createCoreBridgeRuntime();

  async function runNative(messages: SDKMessage[]) {
    const context = new Doppel("native-completion", "guest").context;
    const native = new PushQueue<CoreResponseEvent>();
    context.beginCommand(fakeModel.id, native);
    const events: CoreResponseEvent[] = [];
    const collecting = (async () => {
      for await (const event of native) events.push(event);
    })();
    const query = (async function* () {
      for (const message of messages) yield message;
    })();
    await coreRuntime.test.consumeQuery(
      query as unknown as Query,
      new Map(),
      fakeModel.id,
      context,
      { onResult() {}, onSessionId() {} },
    );
    coreRuntime.test.finalizeCurrentResponse(context);
    await collecting;
    return events;
  }

  const result = (overrides: Record<string, unknown> = {}) =>
    ({
      type: "result",
      subtype: "success",
      result: "answer",
      is_error: false,
      modelUsage: {},
      ...overrides,
    }) as SDKMessage;

  function terminalError(events: CoreResponseEvent[]) {
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "terminal_error");
    if (terminal?.type !== "terminal_error") throw new Error("expected terminal_error");
    return terminal;
  }

  it("carries retry status from a structured overloaded assistant error", async () => {
    const terminal = terminalError(
      await runNative([
        {
          type: "assistant",
          error: "overloaded",
          message: { role: "assistant", model: "<synthetic>", content: [] },
        } as SDKMessage,
        result(),
      ]),
    );
    assert.equal(terminal.retryableStatus, 529);
  });

  it("carries retry status from result api_error_status", async () => {
    const terminal = terminalError(
      await runNative([result({ api_error_status: 529, is_error: true })]),
    );
    assert.equal(terminal.retryableStatus, 529);
  });

  it("carries 429 for a rejected structured rate-limit event", async () => {
    const terminal = terminalError(
      await runNative([
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        } as SDKMessage,
        result(),
      ]),
    );
    assert.equal(terminal.retryableStatus, 429);
  });

  it("does not infer retry status from error text", async () => {
    const terminal = terminalError(
      await runNative([
        result({
          subtype: "error_during_execution",
          is_error: true,
          errors: ["upstream returned 529 overloaded"],
        }),
      ]),
    );
    assert.equal(terminal.retryableStatus, undefined);
  });

  it("resets retry status before the subsequent turn", async () => {
    const context = new Doppel("native-retry-reset", "guest").context;

    async function runTurn(messages: SDKMessage[], first: boolean) {
      const native = new PushQueue<CoreResponseEvent>();
      if (first) context.beginCommand(fakeModel.id, native);
      else context.resetTurnState(fakeModel.id, native);
      const events: CoreResponseEvent[] = [];
      const collecting = (async () => {
        for await (const event of native) events.push(event);
      })();
      const query = (async function* () {
        for (const message of messages) yield message;
      })();
      await coreRuntime.test.consumeQuery(
        query as unknown as Query,
        new Map(),
        fakeModel.id,
        context,
        { onResult() {}, onSessionId() {} },
      );
      coreRuntime.test.finalizeCurrentResponse(context);
      await collecting;
      return terminalError(events);
    }

    assert.equal(
      (await runTurn([result({ api_error_status: 529, is_error: true })], true)).retryableStatus,
      529,
    );
    assert.equal(
      (
        await runTurn(
          [result({ subtype: "error_during_execution", is_error: true, errors: ["plain"] })],
          false,
        )
      ).retryableStatus,
      undefined,
    );
  });

  it("withholds message_stop until a successful SDK result and emits it exactly once", async () => {
    let releaseResult: () => void;
    const resultReady = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const context = new Doppel("native-withholding", "guest").context;
    const native = new PushQueue<CoreResponseEvent>();
    context.beginCommand(fakeModel.id, native);
    const events: CoreResponseEvent[] = [];
    const collecting = (async () => {
      for await (const event of native) events.push(event);
    })();
    const query = (async function* () {
      yield {
        type: "stream_event",
        event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
      } as SDKMessage;
      yield { type: "stream_event", event: { type: "message_stop" } } as SDKMessage;
      await resultReady;
      yield result();
    })();
    const consuming = coreRuntime.test.consumeQuery(
      query as unknown as Query,
      new Map(),
      fakeModel.id,
      context,
      { onResult() {}, onSessionId() {} },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      events.some((event) => event.type === "message_stop"),
      false,
    );
    assert.ok(releaseResult);
    releaseResult();
    await consuming;
    coreRuntime.test.finalizeCurrentResponse(context);
    await collecting;
    assert.equal(events.filter((event) => event.type === "message_stop").length, 1);
    assert.deepEqual(
      events.slice(-2).map((event) => event.type),
      ["message_stop", "response"],
    );
  });

  it("omits message_stop after an SDK result error", async () => {
    const events = await runNative([
      result({ subtype: "error_during_execution", is_error: true, errors: ["literal failure"] }),
    ]);
    assert.deepEqual(
      events.map((event) => event.type),
      ["terminal_error"],
    );
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "terminal_error");
    if (terminal?.type === "terminal_error") assert.equal(terminal.message, "literal failure");
  });

  it("completes assistant-only and result-only fallback sequences", async () => {
    const assistantOnly = await runNative([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: fakeModel.id,
          content: [{ type: "text", text: "assistant fallback", citations: null }],
        },
      } as SDKMessage,
      result({ result: "assistant fallback" }),
    ]);
    const resultOnly = await runNative([result({ result: "result fallback" })]);
    for (const events of [assistantOnly, resultOnly]) {
      assert.deepEqual(
        events.slice(-3).map((event) => event.type),
        ["message_delta", "message_stop", "response"],
      );
    }
  });

  it("hands off a tool response before the SDK result", async () => {
    const events = await runNative([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: fakeModel.id,
          content: [{ type: "tool_use", id: "tool-1", name: "read", input: { path: "x" } }],
        },
      } as SDKMessage,
      result({ result: "" }),
    ]);
    assert.equal(events.filter((event) => event.type === "message_stop").length, 1);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, "response");
    if (terminal?.type === "response")
      assert.equal(terminal.response.message.stop_reason, "tool_use");
  });
});
