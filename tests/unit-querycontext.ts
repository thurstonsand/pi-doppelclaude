/**
 * Tests for the QueryContext class: turn-state isolation, guards, and the
 * streaming input queue. Uses the real module — no API calls, no activation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import { Doppel } from "doppelclaude/doppel";
import { PushQueue } from "doppelclaude/query-state";

const queue = () => new PushQueue<CoreResponseEvent>();

describe("QueryContext class", () => {
  it("turnBlocks throws before resetTurnState", () => {
    const c = new Doppel("test-doppel", "guest").context;
    assert.throws(() => c.turnBlocks, /turnBlocks accessed before resetTurnState/);
  });

  it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
    const c = new Doppel("test-doppel", "guest").context;
    c.resetTurnState("test-model", queue());
    assert.ok(Array.isArray(c.turnBlocks));
    assert.strictEqual(c.turnBlocks.length, 0);

    c.turnBlocks.push({ type: "text", text: "hello", citations: null });
    assert.strictEqual(c.turnOutput.message.content.length, 1);
    const firstBlock = c.turnOutput.message.content[0];
    assert(firstBlock.type === "text");
    assert.strictEqual(firstBlock.text, "hello");
    // Same array reference
    assert.strictEqual(c.turnBlocks, c.turnOutput.message.content);
  });

  it("resetTurnState preserves query-scoped tool call tracking", () => {
    const c = new Doppel("test-doppel", "guest").context;
    c.shownToolCallIds.add("id1");
    c.dispatchedToolCallIds.add("id1");
    c.rejectedToolCallIds.add("id2");
    c.resetTurnState("test-model", queue());

    assert.deepStrictEqual([...c.shownToolCallIds], ["id1"]);
    assert.deepStrictEqual([...c.dispatchedToolCallIds], ["id1"]);
    assert.deepStrictEqual([...c.rejectedToolCallIds], ["id2"]);
  });

  it("fresh instances share no query state", async () => {
    const a = new Doppel("test-doppel", "guest").context;
    const b = new Doppel("test-doppel", "guest").context;
    const blocked = a.blockOnToolResult("t1", "read");
    a.latestCursor = 42;
    assert.strictEqual(b.pendingToolCallCount, 0);
    assert.strictEqual(b.hasPendingToolCall("t1"), false);
    assert.strictEqual(b.latestCursor, 0);

    // Releasing a's handlers leaves b with nothing to release, and answers the one blocked here.
    b.releasePendingToolCalls("Query ended");
    assert.strictEqual(a.pendingToolCallCount, 1);
    a.releasePendingToolCalls("Query ended");
    assert.deepEqual((await blocked).content, [{ type: "text", text: "Query ended" }]);
  });
});

describe("PushQueue", () => {
  it("keeps streaming until explicitly ended", async () => {
    const queue = new PushQueue();
    const iterator = queue[Symbol.asyncIterator]();
    queue.push("first");
    assert.deepStrictEqual(await iterator.next(), { value: "first", done: false });
    const second = iterator.next();
    queue.push("second");
    assert.deepStrictEqual(await second, { value: "second", done: false });
    queue.end();
    assert.deepStrictEqual(await iterator.next(), { value: undefined, done: true });
    assert.throws(() => queue.push("late"), /ended input queue/);
  });
});
