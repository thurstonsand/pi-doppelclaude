import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseCompactionEndEvent,
	parseCompactionResult,
	parseRpcMessage,
} from "./lib/rpc-harness.js";

describe("RPC harness boundaries", () => {
	it("conforms the finite message fields used by integration tests", () => {
		assert.deepEqual(parseRpcMessage({
			type: "response",
			id: "req_1",
			success: true,
			data: { value: 1 },
			ignored: "not propagated",
		}), {
			type: "response",
			id: "req_1",
			success: true,
			error: undefined,
			reason: undefined,
			toolName: undefined,
			aborted: undefined,
			data: { value: 1 },
			result: undefined,
			assistantMessageEvent: undefined,
		});
	});

	it("rejects malformed message fields", () => {
		assert.throws(() => parseRpcMessage({ type: "response", success: "yes" }), /success must be a boolean/);
		assert.throws(() => parseRpcMessage({ id: "req_1" }), /type must be a string/);
	});

	it("conforms compaction command results", () => {
		assert.deepEqual(parseCompactionResult({
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 42,
			details: { readFiles: ["a.ts"] },
		}), {
			summary: "summary",
			firstKeptEntryId: "entry-1",
			tokensBefore: 42,
			details: { readFiles: ["a.ts"] },
		});
		assert.throws(() => parseCompactionResult({ summary: "summary", tokensBefore: "42" }), /tokensBefore must be a finite number/);
	});

	it("conforms compaction events after event matching", () => {
		const event = parseCompactionEndEvent(parseRpcMessage({
			type: "compaction_end",
			aborted: false,
			result: { summary: "summary" },
		}));
		assert.equal(event.aborted, false);
		assert.equal(event.result.summary, "summary");
		assert.throws(
			() => parseCompactionEndEvent(parseRpcMessage({ type: "compaction_end", result: { summary: "summary" } })),
			/aborted must be a boolean/,
		);
	});
});
