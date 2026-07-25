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
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AccountSnapshot } from "../src/account-probe.js";
import { createAnthropicAgentSdkProvider } from "../src/provider.js";
import { PROVIDER_API, PROVIDER_BASE_URL, PROVIDER_ID, PROVIDER_NAME } from "../src/models.js";

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

function providerWith(spy?: (model: Model<any>, options: SimpleStreamOptions | undefined) => void, accountProbe = async () => availableAccount) {
	return createAnthropicAgentSdkProvider({
		accountProbe,
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
		assert.equal(provider.getModels().length, 7);
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
	it("starts one probe without making check await it, then resolve shares it", async () => {
		let resolveProbe: (snapshot: AccountSnapshot) => void = () => {};
		let probes = 0;
		const provider = providerWith(undefined, () => {
			probes++;
			return new Promise<AccountSnapshot>((resolve) => { resolveProbe = resolve; });
		});

		assert.deepEqual(await provider.auth.apiKey!.check!(authInput), { type: "api_key", source: "Claude Code" });
		assert.equal(probes, 1);
		const resolution = provider.auth.apiKey!.resolve(authInput);
		let settled = false;
		void resolution.finally(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false);
		assert.equal(probes, 1);

		resolveProbe(availableAccount);
		assert.deepEqual(await resolution, { auth: {}, source: "Claude Code" });
	});

	it("returns unavailable only after a completed logged-out probe while retrying in the background", async () => {
		const resolvers: Array<(snapshot: AccountSnapshot) => void> = [];
		const provider = providerWith(undefined, () => new Promise((resolve) => { resolvers.push(resolve); }));
		assert.ok(await provider.auth.apiKey!.check!(authInput));
		resolvers.shift()!(unavailableAccount);
		assert.equal(await provider.auth.apiKey!.resolve(authInput), undefined);

		assert.equal(await provider.auth.apiKey!.check!(authInput), undefined);
		assert.equal(resolvers.length, 1);
		resolvers.shift()!(availableAccount);
		assert.deepEqual(await provider.auth.apiKey!.resolve(authInput), { auth: {}, source: "Claude Code" });
	});

	it("retains probe failures for resolve without creating an unhandled rejection", async () => {
		let rejectProbe: (error: Error) => void = () => {};
		const provider = providerWith(undefined, () => new Promise((_resolve, reject) => { rejectProbe = reject; }));
		assert.ok(await provider.auth.apiKey!.check!(authInput));
		rejectProbe(new Error("Run `claude auth login`"));
		await new Promise((resolve) => setImmediate(resolve));
		await assert.rejects(provider.auth.apiKey!.resolve(authInput), /claude auth login/);
	});

	it("shares one in-flight account probe across concurrent checks", async () => {
		let resolveProbe: (snapshot: AccountSnapshot) => void = () => {};
		let probes = 0;
		const provider = providerWith(undefined, () => {
			probes++;
			return new Promise<AccountSnapshot>((resolve) => { resolveProbe = resolve; });
		});
		assert.deepEqual(await Promise.all([
			provider.auth.apiKey!.check!(authInput),
			provider.auth.apiKey!.check!(authInput),
		]), [
			{ type: "api_key", source: "Claude Code" },
			{ type: "api_key", source: "Claude Code" },
		]);
		assert.equal(probes, 1);
		resolveProbe(availableAccount);
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
			assert.match(result.errorMessage!, /Unsupported Anthropic Agent SDK model/);
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
