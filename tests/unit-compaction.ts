import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createCompaction } from "../src/compaction.js";
import { required } from "./lib/expect.js";
import { bridgeModel } from "./lib/models.js";

const model = bridgeModel("claude-haiku-4-5");
const usage = {
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 13,
  cache_creation_input_tokens: 17,
};

function resultMessage(attempt: number): SDKMessage {
  if (attempt === 1) {
    return {
      type: "result",
      subtype: "error_during_execution",
      errors: ["503 service unavailable"],
      usage: { ...usage },
      modelUsage: {},
    } as SDKMessage;
  }
  return {
    type: "result",
    subtype: "success",
    result: "Retried summary",
    usage: { ...usage },
    modelUsage: {},
  } as SDKMessage;
}

describe("isolated compaction accounting", () => {
  it("retries transient summary failures and retains only successful-attempt usage", async () => {
    let attempts = 0;
    let queryCwd: string | undefined;
    let providerSettingsCwd: string | undefined;
    const requestedCwd = "/tmp/phase-3-compaction-cwd";
    const compaction = createCompaction({
      queryFactory: (request) => {
        queryCwd = request.options?.cwd;
        const message = resultMessage(++attempts);
        return {
          async *[Symbol.asyncIterator]() {
            yield message;
          },
          async interrupt() {},
          close() {},
        };
      },
      loadProviderSettings: (cwd) => {
        providerSettingsCwd = cwd;
        return { systemPromptMode: "claude-code" };
      },
      loadRetryPolicy: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }),
    });

    const result = await compaction.run({
      preparation: {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "Summarize this", timestamp: 1 }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), edited: new Set(), written: new Set() },
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      },
      model,
      branchEntries: [],
      customInstructions: undefined,
      signal: undefined,
      cwd: requestedCwd,
      projectTrusted: true,
    });

    assert.equal(queryCwd, requestedCwd);
    assert.equal(providerSettingsCwd, requestedCwd);
    assert.equal(attempts, 2);
    assert.equal(result.summary, "Retried summary");
    assert.deepEqual(
      { ...result.usage, cost: undefined },
      {
        input: 11,
        output: 7,
        cacheRead: 13,
        cacheWrite: 17,
        totalTokens: 48,
        cost: undefined,
      },
    );
    assert.ok(Math.abs(required(result.usage, "summary usage").cost.total - 0.00006855) < 1e-12);
  });

  it("combines usage from both successful split-turn summaries", async () => {
    let attempts = 0;
    const compaction = createCompaction({
      queryFactory: () => {
        attempts++;
        const message = resultMessage(2);
        return {
          async *[Symbol.asyncIterator]() {
            yield message;
          },
          async interrupt() {},
          close() {},
        };
      },
      loadProviderSettings: () => ({ systemPromptMode: "claude-code" }),
      loadRetryPolicy: () => ({ enabled: true, maxRetries: 1, baseDelayMs: 0 }),
    });

    const result = await compaction.run({
      preparation: {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "Earlier history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "Large turn prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 200,
        fileOps: { read: new Set(), edited: new Set(), written: new Set() },
        settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
      },
      model,
      branchEntries: [],
      customInstructions: undefined,
      signal: undefined,
      cwd: process.cwd(),
      projectTrusted: true,
    });

    assert.equal(attempts, 2);
    assert.equal(result.usage?.totalTokens, 96);
  });
});
