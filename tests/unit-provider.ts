import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type RefreshModelsContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AccountSnapshot } from "pi-doppelclaude/account-probe";
import type { BridgeModelCatalog } from "pi-doppelclaude/model-catalog";
import {
  type BridgeModel,
  PROVIDER_API,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "pi-doppelclaude/models";
import { createAnthropicAgentSdkProvider } from "pi-doppelclaude/provider";
import { required } from "./lib/expect.js";
import { bridgeModel } from "./lib/models.js";

const context: Context = { messages: [{ role: "user", content: "test", timestamp: 1 }] };
const authInput = {
  ctx: {
    env: async (): Promise<string | undefined> => undefined,
    fileExists: async (): Promise<boolean> => false,
  },
  signal: new AbortController().signal,
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function successfulStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
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
    timestamp: Date.now(),
  };
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}

const availableAccount: AccountSnapshot = { available: true, supportedModels: [] };
const unavailableAccount: AccountSnapshot = { available: false, supportedModels: [] };

function refreshContext(allowNetwork: boolean): RefreshModelsContext {
  return {
    allowNetwork,
    signal: new AbortController().signal,
    async publish(publication) {
      publication.update?.();
      return true;
    },
  };
}

// Provider coverage owns stream/auth/composition boundaries; catalog assembly is proven in
// unit-model-catalog, so these tests state the discovered models outright.
const discoveredModels = [
  bridgeModel("claude-opus-4-8"),
  bridgeModel("claude-sonnet-5"),
  bridgeModel("claude-haiku-4-5"),
];

function stubCatalog(models: readonly BridgeModel[] = discoveredModels): BridgeModelCatalog {
  return {
    getModels: () => models,
    async noteServedModel() {},
    // Stands in for the real catalog's contract: it asks Claude Code only when it needs discovery.
    async refresh(context, requestSupportedModels) {
      if (context.allowNetwork) await requestSupportedModels();
    },
  };
}

function providerWith(
  spy?: (model: Model<Api>, options: SimpleStreamOptions | undefined) => void,
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
    assert.match(
      required(provider.auth.apiKey, "ambient apiKey auth").name,
      /Claude Code CLI.*claude auth login/,
    );
    assert.deepEqual(
      provider.getModels().map((model) => model.id),
      discoveredModels.map((model) => model.id),
    );
    assert.ok(provider.getModels().every((model) => model.api === PROVIDER_API));
  });

  it("filters unknown IDs and changed identity metadata", () => {
    const provider = providerWith();
    const valid = provider.getModels()[0];
    const candidates: Model<Api>[] = [
      valid,
      { ...valid, id: "claude-future-9-9" },
      { ...valid, provider: "anthropic" },
      { ...valid, api: "anthropic-messages" },
      { ...valid, baseUrl: "https://example.invalid" },
    ];
    // Pi's contract narrows the parameter to this provider's api; feeding it mislabeled
    // models is the whole point of the test, so the cast stands in for a misbehaving caller.
    assert.deepEqual(provider.filterModels(candidates as Model<typeof PROVIDER_API>[], undefined), [
      valid,
    ]);
  });
});

describe("ambient Claude Code auth", () => {
  it("answers auth from cached state without ever probing", async () => {
    let probes = 0;
    const provider = providerWith(undefined, async () => {
      probes++;
      return availableAccount;
    });
    const apiKey = required(provider.auth.apiKey, "ambient apiKey auth");

    assert.deepEqual(await apiKey.check(authInput), {
      type: "api_key",
      source: "Claude Code",
    });
    assert.deepEqual(await apiKey.resolve(authInput), {
      auth: {},
      source: "Claude Code",
    });
    assert.equal(probes, 0);
  });

  it("probes only when the catalog asks and reports Claude Code's login remedy", async () => {
    let probes = 0;
    let snapshot = availableAccount;
    const provider = providerWith(undefined, async () => {
      probes++;
      return snapshot;
    });
    const apiKey = required(provider.auth.apiKey, "ambient apiKey auth");

    await provider.refreshModels(refreshContext(false));
    assert.equal(probes, 0);

    snapshot = unavailableAccount;
    await provider.refreshModels(refreshContext(true));
    assert.equal(probes, 1);
    const loginRemedy = {
      message:
        "Claude Code is not authenticated. Run `claude auth login`, then restart pi or open `/model` to refresh authentication.",
    };
    await assert.rejects(apiKey.check(authInput), loginRemedy);
    await assert.rejects(apiKey.resolve(authInput), loginRemedy);

    snapshot = availableAccount;
    await provider.refreshModels(refreshContext(true));
    assert.equal(probes, 2);
    assert.deepEqual(await apiKey.check(authInput), {
      type: "api_key",
      source: "Claude Code",
    });
  });

  it("surfaces probe failure to Pi's refresh instead of swallowing it", async () => {
    const provider = providerWith(undefined, async () => {
      throw new Error(
        "Claude Code authentication check failed. Run `claude auth login` and try again.",
      );
    });
    await assert.rejects(provider.refreshModels(refreshContext(true)), /claude auth login/);
    assert.deepEqual(await required(provider.auth.apiKey, "ambient apiKey auth").check(authInput), {
      type: "api_key",
      source: "Claude Code",
    });
  });

  it("shares one in-flight account probe across concurrent refreshes", async () => {
    let resolveProbe: (snapshot: AccountSnapshot) => void = () => {};
    let probes = 0;
    const provider = providerWith(undefined, () => {
      probes++;
      return new Promise<AccountSnapshot>((resolve) => {
        resolveProbe = resolve;
      });
    });
    const refreshes = Promise.all([
      provider.refreshModels(refreshContext(true)),
      provider.refreshModels(refreshContext(true)),
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
      const provider = providerWith(() => {
        runtimeCalls++;
      });
      const invalid = { ...provider.getModels()[0], id: "claude-future-9-9" };
      const events = [];
      const stream =
        method === "stream"
          ? provider.stream(invalid, context)
          : provider.streamSimple(invalid, context);
      for await (const event of stream) events.push(event);
      const result = await stream.result();
      assert.equal(runtimeCalls, 0);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "error");
      assert.equal(result.stopReason, "error");
      assert.match(
        required(result.errorMessage, "a terminal error message"),
        /Unsupported Doppelclaude model/,
      );
    });
  }
});

describe("models.json composition", () => {
  it("preserves modelOverrides while filtering and rejecting added IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "native-provider-models-"));
    tempDirs.push(dir);
    const modelsPath = join(dir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          [PROVIDER_ID]: {
            modelOverrides: {
              "claude-opus-4-8": { contextWindow: 200_000, name: "Overridden Opus" },
            },
            models: [{ id: "claude-future-9-9", api: PROVIDER_API, baseUrl: PROVIDER_BASE_URL }],
          },
        },
      }),
    );

    const streamedModels: Model<Api>[] = [];
    const provider = providerWith((model) => streamedModels.push(model));
    const runtime = await ModelRuntime.create({
      modelsPath,
      authPath: join(dir, "auth.json"),
      modelsStorePath: join(dir, "models-store.json"),
    });
    runtime.registerNativeProvider(provider);
    await runtime.refresh({ allowNetwork: false });

    const overridden = required(
      runtime.getModel(PROVIDER_ID, "claude-opus-4-8"),
      "the composed claude-opus-4-8 model",
    );
    assert.equal(overridden.name, "Overridden Opus");
    assert.equal(overridden.contextWindow, 200_000);
    assert.ok(runtime.getModel(PROVIDER_ID, "claude-future-9-9"));
    assert.equal(
      (await runtime.getAvailable(PROVIDER_ID)).some((model) => model.id === "claude-future-9-9"),
      false,
    );

    await runtime.streamSimple(overridden, context).result();
    assert.equal(streamedModels[0].contextWindow, 200_000);
    const invalidResult = await runtime
      .streamSimple(
        required(runtime.getModel(PROVIDER_ID, "claude-future-9-9"), "the models.json addition"),
        context,
      )
      .result();
    assert.equal(invalidResult.stopReason, "error");
    assert.equal(streamedModels.length, 1);
  });
});
