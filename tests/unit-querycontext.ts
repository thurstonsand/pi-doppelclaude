/**
 * Tests for the QueryContext class: turn-state isolation, guards, and the
 * streaming input queue. Uses the real module — no API calls, no activation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { PushQueue, QueryContext } from "../src/query-state.js";

// Minimal stand-in for pi-ai's Model; resetTurnState only records identity here.
const fakeModel = { api: "anthropic-agent-sdk", provider: "anthropic-agent-sdk", id: "test-model" } as Model<any>;

describe("QueryContext class", () => {
	it("turnBlocks throws before resetTurnState", () => {
		const c = new QueryContext();
		assert.throws(() => c.turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		const c = new QueryContext();
		c.resetTurnState(fakeModel);
		assert.ok(Array.isArray(c.turnBlocks));
		assert.strictEqual(c.turnBlocks.length, 0);

		c.turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(c.turnOutput.content.length, 1);
		const firstBlock = c.turnOutput.content[0];
		assert(firstBlock.type === "text");
		assert.strictEqual(firstBlock.text, "hello");
		// Same array reference
		assert.strictEqual(c.turnBlocks, c.turnOutput.content);
	});

	it("resetTurnState preserves query-scoped tool call tracking", () => {
		const c = new QueryContext();
		c.shownToolCallIds.add("id1");
		c.dispatchedToolCallIds.add("id1");
		c.rejectedToolCallIds.add("id2");
		c.resetTurnState(fakeModel);

		assert.deepStrictEqual([...c.shownToolCallIds], ["id1"]);
		assert.deepStrictEqual([...c.dispatchedToolCallIds], ["id1"]);
		assert.deepStrictEqual([...c.rejectedToolCallIds], ["id2"]);
	});

	it("fresh instances share no query state", () => {
		const a = new QueryContext();
		const b = new QueryContext();
		a.pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });
		a.latestCursor = 42;
		assert.strictEqual(b.pendingToolCalls.size, 0);
		assert.strictEqual(b.latestCursor, 0);
		assert.notStrictEqual(a.pendingToolCalls, b.pendingToolCalls);
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
