/**
 * Tests for QueryContext class and context stack infrastructure.
 * Exercises isolation, guards, streaming input queueing, and context pinning
 * using the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PushQueue, ctx, pushContext, popContext, resetStack, stackDepth } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };
const activeQuery = (id) => ({ id, async interrupt() {}, close() {} });

describe("QueryContext class", () => {
	beforeEach(() => resetStack());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.ok(Array.isArray(ctx().turnBlocks));
		assert.strictEqual(ctx().turnBlocks.length, 0);

		ctx().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(ctx().turnOutput.content.length, 1);
		assert.strictEqual(ctx().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(ctx().turnBlocks, ctx().turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
	});
});

describe("context stack guards", () => {
	beforeEach(() => resetStack());

	it("pushContext throws with no active query", () => {
		assert.throws(() => pushContext(), /no active query/);
	});

	it("popContext throws on empty stack", () => {
		assert.throws(() => popContext(), /empty stack/);
	});
});

describe("stack isolation and restore", () => {
	beforeEach(() => resetStack());

	it("push/pop isolates state and restores parent", () => {
		// Parent setup
		ctx().activeQuery = activeQuery("parent");
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });
		ctx().latestCursor = 42;
		ctx().readyForInput = true;

		// Push — child should be clean
		pushContext();
		assert.strictEqual(ctx().activeQuery, null);
		assert.strictEqual(ctx().pendingToolCalls.size, 0);
		assert.strictEqual(ctx().pendingResults.size, 0);
		assert.strictEqual(ctx().latestCursor, 0);
		assert.strictEqual(ctx().readyForInput, false);

		// Mutate child
		ctx().activeQuery = activeQuery("child");
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		ctx().latestCursor = 99;

		// Pop — parent restored
		popContext();
		assert.equal(ctx().activeQuery.id, "parent");
		assert.strictEqual(ctx().pendingToolCalls.size, 1);
		assert.ok(ctx().pendingToolCalls.has("t1"));
		assert.strictEqual(ctx().latestCursor, 42);
	});

	it("triple-nested isolation — each level independent, pop restores", () => {
		// Level 0 (root)
		ctx().activeQuery = activeQuery("L0");
		ctx().latestCursor = 10;
		ctx().persistent = true;

		// Level 1
		pushContext();
		assert.strictEqual(stackDepth(), 1);
		ctx().activeQuery = activeQuery("L1");
		ctx().latestCursor = 20;
		ctx().persistent = false;

		// Level 2
		pushContext();
		assert.strictEqual(stackDepth(), 2);
		ctx().activeQuery = activeQuery("L2");
		ctx().latestCursor = 30;
		ctx().persistent = false;

		// Pop L2 → L1
		popContext();
		assert.strictEqual(stackDepth(), 1);
		assert.equal(ctx().activeQuery.id, "L1");
		assert.strictEqual(ctx().latestCursor, 20);

		// Pop L1 → L0
		popContext();
		assert.strictEqual(stackDepth(), 0);
		assert.equal(ctx().activeQuery.id, "L0");
		assert.strictEqual(ctx().latestCursor, 10);
		assert.strictEqual(ctx().persistent, true);
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

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetStack());

	it("captured context ref stays valid across push/pop", () => {
		ctx().activeQuery = activeQuery("parent");
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });

		// Simulate handler capturing parent context before push
		const capturedCtx = ctx();

		pushContext();
		// After push, ctx() is the child — but capturedCtx still points to parent
		assert.notStrictEqual(ctx(), capturedCtx);
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);
		assert.ok(capturedCtx.pendingToolCalls.has("t1"));

		// Mutate child — captured parent unaffected
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);

		// Pop restores parent as current
		popContext();
		assert.strictEqual(ctx(), capturedCtx);
	});
});
