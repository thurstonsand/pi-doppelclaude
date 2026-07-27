import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Context,
	type Model,
	type ModelsStoreEntry,
	type ProviderModelsStore,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AccountSnapshot } from "../src/account-probe.js";
import type { BridgeModelCatalog } from "../src/model-catalog.js";
import { createAnthropicAgentSdkProvider } from "../src/provider.js";
import { PROVIDER_API, PROVIDER_BASE_URL, PROVIDER_ID, PROVIDER_NAME, type BridgeModel } from "../src/models.js";
import { bridgeModel } from "./lib/models.js";

const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
const authInput = {
	ctx: {
		env: async (): Promise<string | undefined> => undefined,
		fileExists: async (): Promise<boolean> => false,
	},
};
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function successfulStream(model: Model<any>) {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	stream.push({ type: "done", reason: "stop", message });
	stream.end(message);
	return stream;
}

const availableAccount: AccountSnapshot = { available: true, supportedModels: [] };
const unavailableAccount: AccountSnapshot = { available: false, supportedModels: [] };

function memoryStore(): ProviderModelsStore {
	let entry: ModelsStoreEntry | undefined;
	return {
		async read() { return entry; },
		async write(written) { entry = structuredClone(written); },
		async delete() { entry = undefined; },
	};
}

// Provider coverage owns stream/auth/composition boundaries; catalog assembly is proven in
// unit-model-catalog, so these tests state the discovered models outright.
const discoveredModels = [bridgeModel("claude-opus-4-8"), bridgeModel("claude-sonnet-5"), bridgeModel("claude-haiku-4-5")];

function stubCatalog(models: readonly BridgeModel[] = discoveredModels): BridgeModelCatalog {
	return {
		getModels: () => models,
		// Stands in for the real catalog's contract: it asks Claude Code only when it needs discovery.
		async refresh(context, requestSupportedModels) {
			if (context.allowNetwork) await requestSupportedModels();
		},
	};
}

function providerWith(
	spy?: (model: Model<any>, options: SimpleStreamOptions | undefined) => void,
	accountProbe = async () => availableAccount,
	modelCatalog: BridgeModelCatalog = stubCatalog(),
) {
	return createAnthropicAgentSdkProvider({
		accountProbe,
		modelCatalog,
		stream(model, _context, options) {
			spy?.(model, options);
			return successfulStream(model);
		},
	});
}

describe("native Provider shape", () => {
	it("declares native identity, ambient auth, and the canonical catalog", () => {
		const provider = providerWith();
		assert.equal(provider.id, PROVIDER_ID);
		assert.equal(provider.name, PROVIDER_NAME);
		assert.equal(provider.baseUrl, PROVIDER_BASE_URL);
		assert.equal(provider.auth.apiKey?.login, undefined);
		assert.match(provider.auth.apiKey!.name, /Claude Code CLI.*claude auth login/);
		assert.deepEqual(provider.getModels().map((model) => model.id), discoveredModels.map((model) => model.id));
		assert.ok(provider.getModels().every((model) => model.api === PROVIDER_API));
	});

	it("filters unknown IDs and changed identity metadata", () => {
		const provider = providerWith();
		const valid = provider.getModels()[0];
		const candidates: Model<any>[] = [
			valid,
			{ ...valid, id: "claude-future-9-9" },
			{ ...valid, provider: "anthropic" },
			{ ...valid, api: "anthropic-messages" },
			{ ...valid, baseUrl: "https://example.invalid" },
		];
		assert.deepEqual(provider.filterModels!(candidates, undefined), [valid]);
	});
});

describe("ambient Claude Code auth", () => {
	it("answers auth from cached state without ever probing", async () => {
		let probes = 0;
		const provider = providerWith(undefined, async () => { probes++; return availableAccount; });

		assert.deepEqual(await provider.auth.apiKey!.check!(authInput), { type: "api_key", source: "Claude Code" });
		assert.deepEqual(await provider.auth.apiKey!.resolve(authInput), { auth: {}, source: "Claude Code" });
		assert.equal(probes, 0);
	});

	it("probes only when the catalog asks and withdraws auth once it reports logout", async () => {
		let probes = 0;
		let snapshot = availableAccount;
		const provider = providerWith(undefined, async () => { probes++; return snapshot; });
		const store = memoryStore();

		await provider.refreshModels!({ store, allowNetwork: false });
		assert.equal(probes, 0);

		snapshot = unavailableAccount;
		await provider.refreshModels!({ store, allowNetwork: true });
		assert.equal(probes, 1);
		assert.equal(await provider.auth.apiKey!.check!(authInput), undefined);
		assert.equal(await provider.auth.apiKey!.resolve(authInput), undefined);

		snapshot = availableAccount;
		await provider.refreshModels!({ store, allowNetwork: true });
		assert.equal(probes, 2);
		assert.deepEqual(await provider.auth.apiKey!.check!(authInput), { type: "api_key", source: "Claude Code" });
	});

	it("surfaces probe failure to Pi's refresh instead of swallowing it", async () => {
		const provider = providerWith(undefined, async () => {
			throw new Error("Claude Code authentication check failed. Run `claude auth login` and try again.");
		});
		await assert.rejects(
			provider.refreshModels!({ store: memoryStore(), allowNetwork: true }),
			/claude auth login/,
		);
		assert.deepEqual(await provider.auth.apiKey!.check!(authInput), { type: "api_key", source: "Claude Code" });
	});

	it("shares one in-flight account probe across concurrent refreshes", async () => {
		let resolveProbe: (snapshot: AccountSnapshot) => void = () => {};
		let probes = 0;
		const provider = providerWith(undefined, () => {
			probes++;
			return new Promise<AccountSnapshot>((resolve) => { resolveProbe = resolve; });
		});
		const refreshes = Promise.all([
			provider.refreshModels!({ store: memoryStore(), allowNetwork: true }),
			provider.refreshModels!({ store: memoryStore(), allowNetwork: true }),
		]);
		await Promise.resolve();
		resolveProbe(availableAccount);
		await refreshes;
		assert.equal(probes, 1);
	});
});

describe("stream boundaries", () => {
	it("delegates both stream methods to one closure", async () => {
		const calls: Array<SimpleStreamOptions | undefined> = [];
		const provider = providerWith((_model, options) => calls.push(options));
		const model = provider.getModels()[0];
		await provider.streamSimple(model, context, { reasoning: "medium" }).result();
		await provider.stream(model, context, { reasoning: "high" }).result();
		await provider.stream(model, context, { reasoning: "incompatible" }).result();
		assert.equal(calls[0]?.reasoning, "medium");
		assert.equal(calls[1]?.reasoning, "high");
		assert.equal(calls[2]?.reasoning, undefined);
	});

	for (const method of ["stream", "streamSimple"] as const) {
		it(`${method} emits a terminal error without invoking the runtime for invalid models`, async () => {
			let runtimeCalls = 0;
			const provider = providerWith(() => { runtimeCalls++; });
			const invalid = { ...provider.getModels()[0], id: "claude-future-9-9" };
			const events = [];
			const stream = method === "stream"
				? provider.stream(invalid, context)
				: provider.streamSimple(invalid, context);
			for await (const event of stream) events.push(event);
			const result = await stream.result();
			assert.equal(runtimeCalls, 0);
			assert.equal(events.length, 1);
			assert.equal(events[0].type, "error");
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage!, /Unsupported Doppelclaude model/);
		});
	}
});

describe("models.json composition", () => {
	it("preserves modelOverrides while filtering and rejecting added IDs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "native-provider-models-"));
		tempDirs.push(dir);
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify({
			providers: {
				[PROVIDER_ID]: {
					modelOverrides: { "claude-opus-4-8": { contextWindow: 200_000, name: "Overridden Opus" } },
					models: [{ id: "claude-future-9-9", api: PROVIDER_API, baseUrl: PROVIDER_BASE_URL }],
				},
			},
		}));

		const streamedModels: Model<any>[] = [];
		const provider = providerWith((model) => streamedModels.push(model));
		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(dir, "auth.json"),
			modelsStorePath: join(dir, "models-store.json"),
		});
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false });

		const overridden = runtime.getModel(PROVIDER_ID, "claude-opus-4-8")!;
		assert.equal(overridden.name, "Overridden Opus");
		assert.equal(overridden.contextWindow, 200_000);
		assert.ok(runtime.getModel(PROVIDER_ID, "claude-future-9-9"));
		assert.equal((await runtime.getAvailable(PROVIDER_ID)).some((model) => model.id === "claude-future-9-9"), false);

		await runtime.streamSimple(overridden, context).result();
		assert.equal(streamedModels[0].contextWindow, 200_000);
		const invalidResult = await runtime.streamSimple(runtime.getModel(PROVIDER_ID, "claude-future-9-9")!, context).result();
		assert.equal(invalidResult.stopReason, "error");
		assert.equal(streamedModels.length, 1);
	});
});
