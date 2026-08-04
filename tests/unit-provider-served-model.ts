import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { type Api, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { Doppel } from "../src/doppel.js";

const fakeModel = {
  api: "doppelclaude",
  provider: "doppelclaude",
  id: "claude-opus-5",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;

const servedUsage = {
  "claude-opus-4-8": {
    inputTokens: 5,
    outputTokens: 7,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.01,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    canonicalModel: "claude-opus-4-8",
    provider: "firstParty",
  },
};

const DETECTED =
  "Claude served claude-opus-4-8 instead of requested claude-opus-5; usage priced from served model";
const RECAP = "Turn served by claude-opus-4-8, not claude-opus-5; usage priced from served model";

function demotedTurn(terminal: unknown, onStreaming: () => void) {
  return (async function* () {
    yield {
      type: "stream_event",
      event: { type: "message_start", message: { model: "claude-opus-4-8-20260401", usage: {} } },
    };
    yield {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
    };
    yield {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    };
    // The turn is still streaming here — anything already reported beat the terminal message.
    onStreaming();
    yield { type: "stream_event", event: { type: "message_stop" } };
    if (terminal) yield terminal;
  })() as unknown as Query;
}

function startedRuntime(warnings: string[], entries: unknown[] = []) {
  const observed: string[] = [];
  const runtime = createBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
    modelCatalog: {
      getModels: () => [],
      async refresh() {},
      async noteServedModel(id) {
        observed.push(id);
      },
    },
  });
  runtime.setHost({
    ui: { notify: (message: string) => warnings.push(message) } as unknown as ExtensionUIContext,
    appendEntry: (customType, data) => entries.push({ customType, data }),
  });
  const queryCtx = new Doppel("test-doppel", "guest").context;
  // The persistent (root) query is the only one that mutates session/model state.
  queryCtx.persistent = true;
  queryCtx.currentPiStream = createAssistantMessageEventStream();
  queryCtx.beginCommand(fakeModel);
  return { runtime, queryCtx, observed };
}

describe("provider served-model reporting", () => {
  it("reports a demotion when it is detected and again when the turn ends", async () => {
    const warnings: string[] = [];
    const { runtime, queryCtx } = startedRuntime(warnings);

    let warningsWhileStreaming: string[] = [];
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      result: "ok",
      modelUsage: servedUsage,
    };
    await runtime.test.consumeQuery(
      demotedTurn(result, () => {
        warningsWhileStreaming = [...warnings];
      }),
      new Map(),
      fakeModel,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );

    assert.deepEqual(warningsWhileStreaming, [DETECTED]);
    assert.deepEqual(warnings, [DETECTED, RECAP]);
    assert.equal(queryCtx.turnOutput?.responseModel, "claude-opus-4-8");

    // The API keeps the conversation on the fallback model; saying so every turn is noise.
    queryCtx.beginCommand(fakeModel);
    queryCtx.currentPiStream = createAssistantMessageEventStream();
    await runtime.test.consumeQuery(
      demotedTurn(result, () => {}),
      new Map(),
      fakeModel,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );
    assert.deepEqual(warnings, [DETECTED, RECAP]);
    assert.equal(queryCtx.turnOutput?.responseModel, "claude-opus-4-8");

    // Picking a different model is a new routing question, so the answer is reported again.
    const otherModel = { ...fakeModel, id: "claude-fable-5" } as Model<Api>;
    queryCtx.beginCommand(otherModel);
    queryCtx.currentPiStream = createAssistantMessageEventStream();
    await runtime.test.consumeQuery(
      demotedTurn(result, () => {}),
      new Map(),
      otherModel,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );
    assert.equal(warnings.length, 4);
    assert.match(warnings[2], /instead of requested claude-fable-5/u);
  });

  it("teaches the catalog the served model", async () => {
    const warnings: string[] = [];
    const { runtime, queryCtx, observed } = startedRuntime(warnings);

    await runtime.test.consumeQuery(
      demotedTurn(undefined, () => {}),
      new Map(),
      fakeModel,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );

    // A model seen serving is a model Pi must be able to name and price.
    assert.deepEqual(observed, ["claude-opus-4-8"]);
  });

  it("repeats the demotion when the turn is aborted instead of completing", async () => {
    const warnings: string[] = [];
    const { runtime, queryCtx } = startedRuntime(warnings);

    await runtime.test.consumeQuery(
      demotedTurn(undefined, () => {}),
      new Map(),
      fakeModel,
      queryCtx,
      {
        onResult() {},
        onSessionId() {},
      },
    );
    assert.deepEqual(warnings, [DETECTED]);

    runtime.test.emitTerminalError(queryCtx, "aborted", "Operation aborted");
    assert.deepEqual(warnings, [DETECTED, RECAP]);
  });

  it("leaves responseModel unset when the served snapshot is the requested model", async () => {
    const warnings: string[] = [];
    const { runtime, queryCtx } = startedRuntime(warnings);

    const sdkQuery = (async function* () {
      yield {
        type: "stream_event",
        event: { type: "message_start", message: { model: "claude-opus-5[1m]", usage: {} } },
      };
    })();

    await runtime.test.consumeQuery(sdkQuery as unknown as Query, new Map(), fakeModel, queryCtx, {
      onResult() {},
      onSessionId() {},
    });

    assert.deepEqual(warnings, []);
    assert.equal(queryCtx.turnOutput?.responseModel, undefined);
  });
});
