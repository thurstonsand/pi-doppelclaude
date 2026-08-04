#!/usr/bin/env node

// Integration tests for tool execution + message interaction scenarios.
// Uses pi in RPC mode with the bridge + SlowTool test extension.
// Exercises how the bridge handles messages arriving during tool execution.

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { createRpcHarness } from "./lib/rpc-harness.js";

const TEST_TIMEOUT = 40_000;

const harness = createRpcHarness({
  name: "tool-message",
  args: [
    "-e",
    "./tests/fixtures/slow-tool-extension.ts",
    "--model",
    "doppelclaude/claude-haiku-4-5",
  ],
  defaultTimeout: TEST_TIMEOUT,
});

describe("tool-message integration", () => {
  const {
    startAndWait,
    stop,
    send,
    waitForEvent,
    waitForMatch,
    collectText,
    promptAndWait,
    DEBUG_LOG,
    RPC_LOG,
  } = harness;

  // --- Lifecycle ---

  before(async () => {
    await startAndWait();
  });

  afterEach(async () => {
    if (harness.pi().exitCode !== null) {
      await startAndWait();
    }
  });

  after(async () => {
    await stop();
    console.log(`  RPC log: ${RPC_LOG}`);
    console.log(`  Debug log: ${DEBUG_LOG}`);
  });

  // --- Tests ---

  it("tool call completes normally", { timeout: TEST_TIMEOUT }, async () => {
    const text = await promptAndWait(
      "Call SlowTool with seconds=1. Then repeat exactly what it returned, nothing else.",
    );
    assert.match(text.toLowerCase(), /slowtool completed/);
  });

  it("followUp during tool execution delivers after tool completes", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const collector = collectText();
    await send({
      type: "prompt",
      message: "Call SlowTool with seconds=5. Then repeat exactly what it returned.",
    });
    await waitForEvent("tool_execution_start");
    // followUp is queued by pi until the current turn finishes
    await send({
      type: "prompt",
      message: "This is a followUp during tool execution.",
      streamingBehavior: "followUp",
    });
    await waitForEvent("agent_end");
    const text = collector.stop();
    assert.match(text.toLowerCase(), /slowtool completed/);
  });

  it("steer during tool execution still delivers tool result", { timeout: 15_000 }, async () => {
    // Issue #3: steer injects a user message into the context during an active
    // tool call. extractAllToolResults stops at the user message and returns 0
    // results, leaving the pending handler stuck.
    const collector = collectText();
    await send({
      type: "prompt",
      message: "Call SlowTool with seconds=2. Then repeat exactly what it returned.",
    });
    await waitForEvent("tool_execution_start");
    await send({
      type: "prompt",
      message: "This is a steer message during tool execution.",
      streamingBehavior: "steer",
    });
    await waitForEvent("agent_end");
    const text = collector.stop();
    assert.match(text.toLowerCase(), /slowtool completed/);
  });

  it("parallel tool calls with steer delivers all results", { timeout: TEST_TIMEOUT }, async () => {
    const collector = collectText();
    await send({
      type: "prompt",
      message:
        "Call SlowTool three times in parallel: seconds=3, seconds=4, seconds=5. Then list all three results.",
    });
    // Wait for at least one tool to start, then inject steer
    await waitForEvent("tool_execution_start");
    await send({
      type: "prompt",
      message: "This is a steer during parallel tool execution.",
      streamingBehavior: "steer",
    });
    await waitForEvent("agent_end");
    const text = collector.stop();
    // All three tools should have their results in the response
    const matches = (text.match(/slowtool completed/gi) || []).length;
    assert.ok(matches >= 3, `Expected 3 SlowTool results, found ${matches}: ${text.slice(0, 300)}`);
  });

  it("steer during text response (no tool call) completes both turns", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    // Steer during text-only streaming: the assistant is generating text (no tool
    // calls), a steer arrives, and pi delivers it after the current turn ends.
    // Risk: if activeQuery hasn't been cleared by the time pi calls streamSimple
    // for the steer, the bridge enters the tool-result-delivery path incorrectly.
    const collector = collectText();
    await send({
      type: "prompt",
      message:
        "Write exactly 12 short numbered sentences about the history of computing, from Babbage to modern times. Do NOT call any tools.",
    });
    // Wait until text is actually streaming before injecting the steer
    await waitForMatch(
      (msg) => msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta",
      "text_delta during assistant response",
    );
    await send({
      type: "prompt",
      message: "After you finish, also say the exact word 'PINEAPPLE' on its own line.",
      streamingBehavior: "steer",
    });
    await waitForEvent("agent_end");
    const text = collector.stop();
    assert.match(text.toLowerCase(), /pineapple/);
  });

  it("steer during tool execution is visible to assistant", { timeout: 20_000 }, async () => {
    // Bug: when a steer arrives during tool execution, pi drains it at the turn
    // boundary and injects it into context alongside the tool result. The bridge
    // sees activeQuery=true, enters tool-result-delivery mode, extracts the tool
    // result, but silently ignores the trailing user message (the steer). Claude
    // never sees the steer content.
    const collector = collectText();
    await send({
      type: "prompt",
      message: "Call SlowTool with seconds=2. After it returns, repeat exactly what it returned.",
    });
    await waitForEvent("tool_execution_start");
    await send({
      type: "prompt",
      message: "IMPORTANT: Also say the exact word 'MANGO' on its own line in your response.",
      streamingBehavior: "steer",
    });
    await waitForEvent("agent_end");
    const text = collector.stop();
    assert.match(
      text.toLowerCase(),
      /mango/,
      `Steer content not visible to assistant: ${text.slice(0, 300)}`,
    );
  });

  it("abort during tool execution recovers cleanly", { timeout: TEST_TIMEOUT }, async () => {
    await send({
      type: "prompt",
      message: "Call SlowTool with seconds=30.",
    });
    await waitForEvent("tool_execution_start");
    const idle = waitForEvent("agent_end");
    await send({ type: "abort" });
    await idle;
    const text = await promptAndWait("Reply with just the word 'recovered'.");
    assert.match(text.toLowerCase(), /recovered/);
  });

  it("an interrupted queued steer cannot leak into the next turn", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    await send({
      type: "prompt",
      message: "Call SlowTool with seconds=30, then wait for more instructions.",
    });
    await waitForEvent("tool_execution_start");
    await send({
      type: "prompt",
      message: "When you can respond, output the forbidden marker QUEUED_LEAK_MARKER.",
      streamingBehavior: "steer",
    });
    const idle = waitForEvent("agent_end");
    await send({ type: "abort" });
    await idle;

    const text = await promptAndWait("Reply with exactly CLEAN_NEXT_TURN and nothing else.");
    assert.match(text, /CLEAN_NEXT_TURN/);
    assert.doesNotMatch(text, /QUEUED_LEAK_MARKER/);
  });
});
