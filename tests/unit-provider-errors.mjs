import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { __test } from "../src/index.js";
import { QueryContext } from "../src/query-state.js";

const fakeModel = {
	api: "claude-bridge",
	provider: "anthropic",
	id: "claude-test",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

async function collect(stream) {
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

		await __test.consumeQuery(sdkQuery, new Map(), fakeModel, () => false, queryCtx);
		__test.finalizeCurrentStream(queryCtx);

		const events = await collect(stream);
		assert.equal(events.at(-1).type, "error");
		assert.equal(events.at(-1).reason, "error");
		assert.equal(events.at(-1).error.stopReason, "error");
		assert.equal(events.at(-1).error.errorMessage, message);
	});
});
