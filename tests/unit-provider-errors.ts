import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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

	// A revoked OAuth token was reported three times: a bogus served-model warning for the
	// `<synthetic>` marker, the error envelope as assistant text, and a terminal error that
	// read "Claude Code failed: success". One failure, one report.
	it("reports a synthetic error envelope once, as the turn's error", async () => {
		const notifications: string[] = [];
		const failure = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
		runtime.setUI({ notify: (text: string) => notifications.push(text) } as unknown as ExtensionUIContext);

		const sdkQuery = (async function* () {
			yield {
				type: "assistant",
				message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: failure }] },
			};
			yield {
				type: "result",
				subtype: "success",
				is_error: true,
				api_error_status: 401,
				terminal_reason: "completed",
				result: failure,
				modelUsage: {
					"<synthetic>": {
						inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
						webSearchRequests: 0, costUSD: 0, contextWindow: 0, maxOutputTokens: 0,
					},
				},
			};
		})();
		const queryCtx = new QueryContext();
		queryCtx.currentPiStream = createAssistantMessageEventStream();
		queryCtx.beginCommand(fakeModel);
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
		assert.equal(last.error.errorMessage, failure);
		assert.deepEqual(last.error.content, [], "the envelope must not enter the transcript");
		assert.deepEqual(notifications, [], "a fabricated message is not a served model");
	});
});
