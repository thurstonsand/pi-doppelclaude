import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { QueryContext } from "../src/query-state.js";

const runtime = createBridgeRuntime({
	providerSettings: { systemPromptMode: "claude-code" },
});

// Minimal stand-in for pi-ai's Model; the stream path only reads api/provider/id/cost.
const fakeModel = {
	api: "doppelclaude",
	provider: "doppelclaude",
	id: "claude-test",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<any>;

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
		const queryCtx = new QueryContext();
		queryCtx.currentPiStream = createAssistantMessageEventStream();
		queryCtx.resetTurnState(fakeModel);
		const stream = queryCtx.currentPiStream;

		await runtime.test.consumeQuery(sdkQuery as unknown as Query, new Map(), fakeModel, queryCtx, {
			onResult() {},
			onSessionId() {},
		});
		runtime.test.finalizeCurrentStream(queryCtx);

		const events = await collect(stream);
		const last = events.at(-1);
		assert.equal(last.type, "error");
		if (last.type !== "error") throw new Error("expected a trailing error event");
		assert.equal(last.reason, "error");
		assert.equal(last.error.stopReason, "error");
		assert.equal(last.error.errorMessage, message);
	});
});
