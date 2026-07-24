import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { applySdkUsage } from "../src/sdk-usage.js";

const model = getBuiltinModels("anthropic").find((candidate) => candidate.id === "claude-haiku-4-5")!;

function output(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("SDK usage mapping", () => {
	it("maps tokens, native reasoning, totals, and model cost", () => {
		const message = output();
		applySdkUsage(message, {
			input_tokens: 10,
			output_tokens: 5,
			cache_read_input_tokens: 20,
			cache_creation_input_tokens: 30,
			reasoning_tokens: 3,
		}, model);

		assert.deepEqual({ ...message.usage, cost: undefined }, {
			input: 10,
			output: 5,
			cacheRead: 20,
			cacheWrite: 30,
			reasoning: 3,
			totalTokens: 65,
			cost: undefined,
		});
		assert.ok(Math.abs(message.usage.cost.total - 0.0000745) < 1e-12);
	});

	it("updates partial reports without clearing fields omitted by later events", () => {
		const message = output();
		applySdkUsage(message, { input_tokens: 10, cache_read_input_tokens: 20 }, model);
		applySdkUsage(message, { output_tokens: 5 }, model);

		assert.equal(message.usage.input, 10);
		assert.equal(message.usage.output, 5);
		assert.equal(message.usage.cacheRead, 20);
		assert.equal(message.usage.totalTokens, 35);
	});
});
