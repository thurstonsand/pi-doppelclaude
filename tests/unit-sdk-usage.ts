import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { accountSdkModelUsage, applySdkUsage, diffSdkModelUsage } from "../src/sdk-usage.js";
import { required } from "./lib/expect.js";

const model = required(
  getBuiltinModels("anthropic").find((candidate) => candidate.id === "claude-haiku-4-5"),
  "Pi's Anthropic catalog to ship claude-haiku-4-5",
);

function output(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("SDK usage mapping", () => {
  it("maps tokens, native reasoning, totals, and model cost", () => {
    const message = output();
    applySdkUsage(
      message,
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        reasoning_tokens: 3,
      },
      model,
    );

    assert.deepEqual(
      { ...message.usage, cost: undefined },
      {
        input: 10,
        output: 5,
        cacheRead: 20,
        cacheWrite: 30,
        reasoning: 3,
        totalTokens: 65,
        cost: undefined,
      },
    );
    assert.ok(Math.abs(message.usage.cost.total - 0.0000745) < 1e-12);
  });

  it("updates partial reports without clearing fields omitted by later events", () => {
    const message = output();
    applySdkUsage(message, { input_tokens: 10, cache_read_input_tokens: 20 }, model);
    applySdkUsage(message, { output_tokens: 5 }, model);

    assert.equal(message.usage.input, 10);
    assert.equal(message.usage.output, 5);
    assert.equal(message.usage.cacheRead, 20);
    assert.equal(message.usage.totalTokens, 35);
  });

  it("deltas cumulative per-model usage and prices a fallback from served models", () => {
    const prior = {
      "claude-haiku-4-5": {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.0002,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        canonicalModel: "claude-haiku-4-5",
        provider: "firstParty",
      },
    };
    const current = {
      "claude-haiku-4-5": {
        inputTokens: 110,
        outputTokens: 15,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 30,
        webSearchRequests: 0,
        costUSD: 0.0003,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        canonicalModel: "claude-haiku-4-5",
        provider: "firstParty",
      },
      "claude-opus-4-8[1m]": {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        webSearchRequests: 0,
        costUSD: 0.00025,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        canonicalModel: "claude-opus-4-8",
        provider: "firstParty",
      },
    };
    const accounting = accountSdkModelUsage(diffSdkModelUsage(current, prior), model);

    assert.deepEqual(
      {
        input: accounting.usage.input,
        output: accounting.usage.output,
        cacheRead: accounting.usage.cacheRead,
        cacheWrite: accounting.usage.cacheWrite,
        totalTokens: accounting.usage.totalTokens,
      },
      { input: 17, output: 8, cacheRead: 22, cacheWrite: 31, totalTokens: 78 },
    );
    assert.ok(Math.abs(accounting.usage.cost.total - 0.00035) < 1e-12);
    assert.ok(
      accounting.usage.cost.input > 0,
      "component pricing should use Pi's served-model catalogs",
    );
    assert.deepEqual(accounting.fallbackModels, ["claude-opus-4-8"]);
    assert.deepEqual(accounting.unknownModels, []);
  });

  it("does not read Claude Code's synthetic marker as a served model", () => {
    const synthetic: ModelUsage = {
      inputTokens: 0,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
      provider: "firstParty",
    };
    const accounting = accountSdkModelUsage({ "<synthetic>": synthetic }, model);

    assert.deepEqual(accounting.servedModels, []);
    assert.deepEqual(accounting.fallbackModels, []);
    assert.deepEqual(accounting.unknownModels, []);
  });
});
