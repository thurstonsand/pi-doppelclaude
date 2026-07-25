import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	buildModels,
	claudeCodeModelId,
	MODEL_IDS_IN_ORDER,
	PROVIDER_API,
	PROVIDER_BASE_URL,
	PROVIDER_ID,
	resolveThinkingEffort,
} from "../src/models.js";

const canonicalModels = getBuiltinModels("anthropic");
const find = <T extends { id: string }>(models: readonly T[], id: string): T => models.find((model) => model.id === id)!;

describe("native model projection", () => {
	it("projects the seven canonical models in the declared order", () => {
		const models = buildModels(canonicalModels);
		assert.deepEqual(models.map((model) => model.id), MODEL_IDS_IN_ORDER);
		for (const model of models) {
			assert.equal(model.provider, PROVIDER_ID);
			assert.equal(model.api, PROVIDER_API);
			assert.equal(model.baseUrl, PROVIDER_BASE_URL);
		}
	});

	it("preserves every canonical metadata field other than provider identity", () => {
		for (const model of buildModels(canonicalModels)) {
			const canonical = find(canonicalModels, model.id);
			assert.equal(model.name, canonical.name);
			assert.equal(model.reasoning, canonical.reasoning);
			assert.deepEqual(model.thinkingLevelMap, canonical.thinkingLevelMap);
			assert.deepEqual(model.input, canonical.input);
			assert.deepEqual(model.cost, canonical.cost);
			assert.equal(model.contextWindow, canonical.contextWindow);
			assert.equal(model.maxTokens, canonical.maxTokens);
		}
	});

	it("fails if Pi's canonical catalog is missing a required model", () => {
		assert.throws(
			() => buildModels(canonicalModels.filter((model) => model.id !== "claude-fable-5")),
			/catalog is missing required model claude-fable-5/,
		);
	});
});

describe("thinking effort", () => {
	const models = buildModels(canonicalModels);

	it("uses native per-model mappings before generic effort aliases", () => {
		assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), "xhigh"), "xhigh");
		assert.equal(resolveThinkingEffort(find(models, "claude-opus-4-6"), "xhigh"), "max");
	});

	it("uses Claude Code defaults when reasoning is off or omitted", () => {
		assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), "max"), "max");
		assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), "off"), undefined);
		assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), undefined), undefined);
	});
});

describe("Claude Code model argument", () => {
	const models = buildModels(canonicalModels);

	it("uses [1m] for canonical long-context models except bare Opus 4.7", () => {
		assert.equal(claudeCodeModelId(find(models, "claude-fable-5")), "claude-fable-5[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-8")), "claude-opus-4-8[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-7")), "claude-opus-4-7");
		assert.equal(claudeCodeModelId(find(models, "claude-opus-4-6")), "claude-opus-4-6[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-sonnet-5")), "claude-sonnet-5[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-sonnet-4-6")), "claude-sonnet-4-6[1m]");
		assert.equal(claudeCodeModelId(find(models, "claude-haiku-4-5")), "claude-haiku-4-5");
	});

	it("uses the final modelOverride context window", () => {
		const opus = { ...find(models, "claude-opus-4-8"), contextWindow: 200_000 };
		const haiku = { ...find(models, "claude-haiku-4-5"), contextWindow: 1_000_000 };
		assert.equal(claudeCodeModelId(opus), "claude-opus-4-8");
		assert.equal(claudeCodeModelId(haiku), "claude-haiku-4-5[1m]");
	});

	it("rejects unknown IDs instead of guessing a context window", () => {
		const unknown = { ...find(models, "claude-opus-4-8"), id: "claude-future-9-9" };
		assert.throws(() => claudeCodeModelId(unknown), /Unsupported Anthropic Agent SDK model/);
	});
});
