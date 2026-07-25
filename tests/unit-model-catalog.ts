import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Model, ModelsStoreEntry, ProviderModelsStore, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { createBridgeModelCatalog, type ModelCatalogDependencies } from "../src/model-catalog.js";
import { claudeCodeModelId, MODEL_IDS_IN_ORDER, PROVIDER_ID } from "../src/models.js";

const builtinModels = getBuiltinModels("anthropic");
const opus48 = builtinModels.find((model) => model.id === "claude-opus-4-8")!;
const opus5: Model<any> = {
	...opus48,
	id: "claude-opus-5",
	name: "Claude Opus 5",
	cost: {
		...opus48.cost,
		tiers: [{ inputTokensAbove: 200_000, input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5 }],
	},
};
const future: Model<any> = { ...opus48, id: "claude-opus-6", name: "Claude Opus 6" };
const supportedModels: ModelInfo[] = [{
	value: "opus[1m]",
	resolvedModel: "claude-opus-5[1m]",
	displayName: "Opus",
	description: "Opus 5",
}];

function memoryStore(initial?: ModelsStoreEntry): ProviderModelsStore & { entry?: ModelsStoreEntry } {
	return {
		entry: initial,
		async read() { return this.entry; },
		async write(entry) { this.entry = structuredClone(entry); },
		async delete() { this.entry = undefined; },
	};
}

function context(store: ProviderModelsStore, allowNetwork: boolean): RefreshModelsContext {
	return { store, allowNetwork, force: true };
}

function response(models: readonly Model<any>[]): Response {
	return new Response(JSON.stringify(models), {
		status: 200,
		headers: { "content-type": "application/json", "last-modified": "Fri, 24 Jul 2026 19:15:06 GMT" },
	});
}

const testDependencies: ModelCatalogDependencies = {
	requestCatalog: async () => { throw new Error("unexpected catalog request"); },
	now: Date.now,
	builtinGeneratedAt: 0,
	builtinModels,
	readSharedCatalog: async () => undefined,
};

describe("dynamic bridge model catalog", () => {
	it("initializes from Pi's shared Anthropic cache before model selection", async () => {
		const catalog = createBridgeModelCatalog({
			...testDependencies,
			readSharedCatalog: async () => ({
				models: [...builtinModels, opus5],
				checkedAt: Date.parse("2026-07-25T00:00:00Z"),
				lastModified: Date.parse("2026-07-24T19:15:06Z"),
			}),
		});
		await catalog.initialize(supportedModels);
		assert.equal(catalog.getModels().some((model) => model.id === "claude-opus-5"), true);
	});

	it("uses a newly published built-in model without requiring a remote cache", async () => {
		let fetches = 0;
		const catalog = createBridgeModelCatalog({
			...testDependencies,
			builtinModels: [...builtinModels, opus5],
			builtinGeneratedAt: Date.parse("2026-07-25T00:00:00Z"),
			requestCatalog: async () => { fetches++; return response([...builtinModels, opus5]); },
		});
		await catalog.initialize(supportedModels);
		assert.equal(fetches, 0);
		assert.equal(catalog.getModels().some((model) => model.id === "claude-opus-5"), true);
	});

	it("fetches the canonical catalog when Pi's shared cache is unusable", async () => {
		let fetches = 0;
		const catalog = createBridgeModelCatalog({
			...testDependencies,
			readSharedCatalog: async () => { throw new Error("corrupt shared cache"); },
			requestCatalog: async () => { fetches++; return response([...builtinModels, opus5]); },
		});
		await catalog.initialize(supportedModels);
		assert.equal(fetches, 1);
		assert.equal(catalog.getModels().some((model) => model.id === "claude-opus-5"), true);
	});

	it("adds only stable models advertised by Claude Code and preserves canonical metadata", async () => {
		const store = memoryStore();
		const catalog = createBridgeModelCatalog({
			...testDependencies,
			now: () => Date.parse("2026-07-25T00:00:00Z"),
			requestCatalog: async () => response([...builtinModels, opus5, future]),
		});

		await catalog.refresh(context(store, true), supportedModels);
		const models = catalog.getModels();
		assert.deepEqual(models.map((model) => model.id), [
			"claude-fable-5",
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-sonnet-5",
			"claude-sonnet-4-6",
			"claude-haiku-4-5",
		]);
		const added = models.find((model) => model.id === "claude-opus-5")!;
		assert.equal(added.provider, PROVIDER_ID);
		assert.deepEqual(added.cost, opus5.cost);
		assert.equal(claudeCodeModelId(added), "claude-opus-5[1m]");
		assert.equal(models.some((model) => model.id === "claude-opus-6"), false);

		const persisted = store.entry as ModelsStoreEntry & { supportedModelIds: string[] };
		assert.ok(persisted.models.every((model) => model.provider === "anthropic" && model.api === "anthropic-messages"));
		assert.ok(persisted.models.some((model) => model.id === "claude-opus-6"));
		assert.deepEqual(persisted.supportedModelIds, ["claude-opus-5"]);

		await catalog.refresh(context(store, true), [
			...supportedModels,
			{ ...supportedModels[0], resolvedModel: "claude-opus-6" },
		]);
		assert.ok(catalog.getModels().some((model) => model.id === "claude-opus-6"));
	});

	it("restores a refreshed model from the provider-scoped cache while offline", async () => {
		const store = memoryStore();
		const online = createBridgeModelCatalog({
			...testDependencies,
			requestCatalog: async () => response([...builtinModels, opus5]),
		});
		await online.refresh(context(store, true), supportedModels);

		const offline = createBridgeModelCatalog({
			...testDependencies,
			requestCatalog: async () => { throw new Error("network must remain unused"); },
		});
		await offline.refresh(context(store, false), []);
		assert.equal(offline.getModels().some((model) => model.id === "claude-opus-5"), true);
	});

	it("retains the seven-model baseline when no refreshed cache exists", async () => {
		const catalog = createBridgeModelCatalog(testDependencies);
		await catalog.refresh(context(memoryStore(), false), []);
		assert.deepEqual(catalog.getModels().map((model) => model.id), MODEL_IDS_IN_ORDER);
	});

	it("records failed attempts separately from successful checks", async () => {
		const checkedAt = Date.parse("2026-07-24T00:00:00Z");
		const failedAt = Date.parse("2026-07-25T00:00:00Z");
		const store = memoryStore({ models: builtinModels, checkedAt, lastModified: checkedAt });
		const catalog = createBridgeModelCatalog({
			...testDependencies,
			now: () => failedAt,
			requestCatalog: async () => { throw new Error("offline"); },
		});
		await assert.rejects(catalog.refresh(context(store, true), supportedModels), /offline/);
		assert.equal(store.entry?.checkedAt, checkedAt);
		assert.equal((store.entry as ModelsStoreEntry & { failedAt: number }).failedAt, failedAt);
	});

	it("rejects malformed remote metadata without replacing the baseline", async () => {
		const catalog = createBridgeModelCatalog({
			...testDependencies,
			requestCatalog: async () => new Response(JSON.stringify([{ id: "claude-opus-5" }]), { status: 200 }),
		});
		await assert.rejects(catalog.refresh(context(memoryStore(), true), supportedModels), /malformed metadata/);
		assert.deepEqual(catalog.getModels().map((model) => model.id), MODEL_IDS_IN_ORDER);
	});
});
