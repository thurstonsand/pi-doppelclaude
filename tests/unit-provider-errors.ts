import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { Doppel } from "../src/doppel.js";

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
		const queryCtx = new Doppel("test-doppel", "guest").context;
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
		runtime.setHost({
			ui: { notify: (text: string) => notifications.push(text) } as unknown as ExtensionUIContext,
			appendEntry() {},
		});

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
		const queryCtx = new Doppel("test-doppel", "guest").context;
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
		// A revoked credential also carries the only instruction that can fix it.
		assert.equal(last.error.errorMessage, `${failure} — usually a transient credential-refresh race; sending the message again typically works. If it persists, run \`claude /login\`.`);
		assert.deepEqual(last.error.content, [], "the envelope must not enter the transcript");
		assert.deepEqual(notifications, [], "a fabricated message is not a served model");
	});
});

// The stream carries Claude's own terminal reason. Treating an unrecognized one as a
// clean stop commits a refused or truncated answer as if the model had finished, so
// every reason is named and anything else fails loudly.
describe("provider stop reasons", () => {
	const streamEvent = (event: unknown) => ({ type: "stream_event", event });

	function turn(stopReason: string | undefined, options: { withResult?: boolean } = {}) {
		const messages: unknown[] = [
			streamEvent({ type: "message_start", message: { model: "claude-test", usage: {} } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
		];
		if (stopReason !== undefined) {
			messages.push(streamEvent({ type: "message_delta", delta: { stop_reason: stopReason } }));
		}
		if (options.withResult !== false) {
			messages.push({ type: "result", subtype: "success", result: "partial", is_error: false, modelUsage: {} });
		}
		return messages;
	}

	async function runTurn(messages: unknown[]) {
		const sdkQuery = (async function* () { for (const message of messages) yield message; })();
		const queryCtx = new Doppel("test-doppel", "guest").context;
		queryCtx.currentPiStream = createAssistantMessageEventStream();
		queryCtx.resetTurnState(fakeModel);
		const stream = queryCtx.currentPiStream;

		await runtime.test.consumeQuery(sdkQuery as unknown as Query, new Map(), fakeModel, queryCtx, {
			onResult() {},
			onSessionId() {},
		});
		runtime.test.finalizeCurrentStream(queryCtx);

		const events = await collect(stream);
		return events.at(-1) as any;
	}

	for (const [reason, expected] of [["end_turn", "stop"], ["stop_sequence", "stop"], ["pause_turn", "stop"], ["max_tokens", "length"]] as const) {
		it(`completes a turn that stopped with ${reason}`, async () => {
			const last = await runTurn(turn(reason));
			assert.equal(last.type, "done");
			assert.equal(last.message.stopReason, expected);
			assert.equal(last.message.rawStopReason, reason, "Claude's own wording survives for diagnostics");
		});
	}

	for (const reason of ["refusal", "model_context_window_exceeded", "a_reason_anthropic_has_not_shipped_yet"]) {
		it(`fails the turn when Claude stopped with ${reason}`, async () => {
			const last = await runTurn(turn(reason));
			assert.equal(last.type, "error", `${reason} must not be reported as a completed turn`);
			assert.equal(last.error.stopReason, "error");
			assert.equal(last.error.rawStopReason, reason);
		});
	}

	it("fails a turn whose stream ended without any terminal reason", async () => {
		const last = await runTurn(turn(undefined, { withResult: false }));
		assert.equal(last.type, "error", "a truncated stream must not commit its partial output");
		assert.equal(last.error.stopReason, "error");
	});

	// Legs that never stream a `message_delta` — partial messages off, or a bare result
	// carrying the text — are completed by the SDK result instead.
	it("completes a turn whose only terminal signal is the SDK result", async () => {
		const last = await runTurn([
			{ type: "result", subtype: "success", result: "answered", is_error: false, modelUsage: {} },
		]);
		assert.equal(last.type, "done");
		assert.equal(last.message.stopReason, "stop");
	});
});
