import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  Model,
  ModelsStoreEntry,
  ProviderModelsStore,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { createBridgeModelCatalog, type ModelCatalogDependencies } from "../src/model-catalog.js";
import { claudeCodeModelId, PROVIDER_ID } from "../src/models.js";
import { required } from "./lib/expect.js";

const builtinModels = getBuiltinModels("anthropic");
const opus48 = required(
  builtinModels.find((model) => model.id === "claude-opus-4-8"),
  "Pi's Anthropic catalog to ship claude-opus-4-8",
);
const opus5: Model<Api> = {
  ...opus48,
  id: "claude-opus-5",
  name: "Claude Opus 5",
  cost: {
    ...opus48.cost,
    tiers: [{ inputTokensAbove: 200_000, input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5 }],
  },
};
const future: Model<Api> = { ...opus48, id: "claude-opus-6", name: "Claude Opus 6" };
const supportedModels: ModelInfo[] = [
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus",
    description: "Opus 5",
  },
];

const undescribedModels: ModelInfo[] = [
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-99[1m]",
    displayName: "Opus",
    description: "Opus 99",
  },
];

function memoryStore(
  initial?: ModelsStoreEntry,
): ProviderModelsStore & { entry?: ModelsStoreEntry } {
  return {
    entry: initial,
    async read() {
      return this.entry;
    },
    async write(entry) {
      this.entry = structuredClone(entry);
    },
    async delete() {
      this.entry = undefined;
    },
  };
}

function context(store: ProviderModelsStore, allowNetwork: boolean): RefreshModelsContext {
  return { store, allowNetwork, force: true };
}

const advertises = (models: readonly ModelInfo[]) => async () => models;
const neverAsked = async (): Promise<readonly ModelInfo[]> => {
  throw new Error("Claude Code must not be asked when the store can answer");
};
const dated: ModelInfo[] = [
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5",
  },
];

function response(models: readonly Model<Api>[]): Response {
  return new Response(JSON.stringify(models), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "last-modified": "Fri, 24 Jul 2026 19:15:06 GMT",
    },
  });
}

const testDependencies: ModelCatalogDependencies = {
  requestCatalog: async () => {
    throw new Error("unexpected catalog request");
  },
  now: Date.now,
  builtinGeneratedAt: 0,
  builtinModels,
};

describe("dynamic bridge model catalog", () => {
  it("restores the last confirmed allowlist on a cold offline start", async () => {
    const store = memoryStore({
      models: [...builtinModels, opus5],
      checkedAt: Date.parse("2026-07-25T00:00:00Z"),
      lastModified: Date.parse("2026-07-24T19:15:06Z"),
      supportedModelIds: ["claude-opus-5"],
    } as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog(testDependencies);
    await catalog.refresh(context(store, false), neverAsked);
    assert.equal(
      catalog.getModels().some((model) => model.id === "claude-opus-5"),
      true,
    );
  });

  it("uses a newly published built-in model offline without a remote cache", async () => {
    const store = memoryStore({
      models: [],
      supportedModelIds: ["claude-opus-5"],
    } as unknown as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      builtinModels: [...builtinModels, opus5],
      builtinGeneratedAt: Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => {
        throw new Error("network must remain unused");
      },
    });
    await catalog.refresh(context(store, false), neverAsked);
    assert.equal(
      catalog.getModels().some((model) => model.id === "claude-opus-5"),
      true,
    );
  });

  it("records a newly advertised model against a still-fresh canonical catalog", async () => {
    const checkedAt = Date.parse("2026-07-25T00:00:00Z");
    const store = memoryStore({
      models: [...builtinModels, opus5],
      checkedAt,
      lastModified: checkedAt,
      supportedModelIds: [],
    } as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => checkedAt,
      requestCatalog: async () => {
        throw new Error("a fresh catalog must not be refetched");
      },
    });

    await catalog.refresh({ ...context(store, true), force: false }, advertises(supportedModels));
    assert.equal(
      catalog.getModels().some((model) => model.id === "claude-opus-5"),
      true,
    );
    assert.deepEqual(
      (store.entry as ModelsStoreEntry & { supportedModelIds: string[] }).supportedModelIds,
      ["claude-opus-5"],
    );
    assert.equal(store.entry?.checkedAt, checkedAt);
  });

  it("refetches when a fresh canonical catalog cannot describe an advertised model", async () => {
    const checkedAt = Date.parse("2026-07-25T00:00:00Z");
    const store = memoryStore({
      models: builtinModels,
      checkedAt,
      lastModified: Date.parse("2026-07-20T00:00:00Z"),
      supportedModelIds: [],
    } as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => checkedAt,
      requestCatalog: async () => response([...builtinModels, opus5]),
    });

    await catalog.refresh({ ...context(store, true), force: false }, advertises(supportedModels));
    assert.equal(
      catalog.getModels().some((model) => model.id === "claude-opus-5"),
      true,
      "a model nothing on hand can describe must be fetched rather than left invisible",
    );
  });

  it("adds only stable models advertised by Claude Code and preserves canonical metadata", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => response([...builtinModels, opus5, future]),
    });

    await catalog.refresh(context(store, true), advertises(supportedModels));
    const models = catalog.getModels();
    assert.deepEqual(
      models.map((model) => model.id),
      ["claude-opus-5"],
    );
    const added = required(
      models.find((model) => model.id === "claude-opus-5"),
      "the catalog to include claude-opus-5",
    );
    assert.equal(added.provider, PROVIDER_ID);
    assert.deepEqual(added.cost, opus5.cost);
    assert.equal(claudeCodeModelId(added), "claude-opus-5[1m]");
    assert.equal(
      models.some((model) => model.id === "claude-opus-6"),
      false,
    );

    const persisted = store.entry as ModelsStoreEntry & { supportedModelIds: string[] };
    assert.ok(
      persisted.models.every(
        (model) => model.provider === "anthropic" && model.api === "anthropic-messages",
      ),
    );
    assert.ok(persisted.models.some((model) => model.id === "claude-opus-6"));
    assert.deepEqual(persisted.supportedModelIds, ["claude-opus-5"]);

    await catalog.refresh(
      context(store, true),
      advertises([...supportedModels, { ...supportedModels[0], resolvedModel: "claude-opus-6" }]),
    );
    assert.ok(catalog.getModels().some((model) => model.id === "claude-opus-6"));
  });

  it("restores a refreshed model from the provider-scoped cache while offline", async () => {
    const store = memoryStore();
    const online = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await online.refresh(context(store, true), advertises(supportedModels));

    const offline = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => {
        throw new Error("network must remain unused");
      },
    });
    await offline.refresh(context(store, false), neverAsked);
    assert.equal(
      offline.getModels().some((model) => model.id === "claude-opus-5"),
      true,
    );
  });

  it("normalizes a dated snapshot onto the family ID Pi describes", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response(builtinModels),
    });
    await catalog.refresh(context(store, true), advertises(dated));
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-haiku-4-5"],
    );
    assert.deepEqual(
      (store.entry as ModelsStoreEntry & { supportedModelIds: string[] }).supportedModelIds,
      ["claude-haiku-4-5"],
    );
  });

  it("drops mutable aliases that name no model family", async () => {
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response(builtinModels),
    });
    await catalog.refresh(
      context(memoryStore(), true),
      advertises([
        { value: "default", displayName: "Default", description: "" },
        {
          value: "sonnet",
          resolvedModel: "claude-sonnet-5",
          displayName: "Sonnet",
          description: "",
        },
      ]),
    );
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-sonnet-5"],
    );
  });
});

describe("first load", () => {
  it("discovers once when the installation has never asked, even while Pi replays caches", async () => {
    const store = memoryStore();
    let asked = 0;
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    const ask = async () => {
      asked++;
      return supportedModels;
    };

    await catalog.refresh(context(store, false), ask);
    assert.equal(asked, 1);
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5"],
    );

    await catalog.refresh(context(store, false), ask);
    assert.equal(asked, 1, "a bootstrapped installation replays its store instead of asking again");
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5"],
    );
  });

  it("rediscovers instead of stranding the provider on an unusable store entry", async () => {
    const store = memoryStore({
      models: [{ id: "claude-opus-5" }],
      supportedModelIds: ["claude-opus-5"],
    } as unknown as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await catalog.refresh(context(store, false), advertises(supportedModels));
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5"],
    );
    assert.ok(store.entry?.models.length, "the unusable entry is replaced");
  });

  it("does not retry a failed first load on every start", async () => {
    const store = memoryStore();
    let asked = 0;
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => {
        throw new Error("offline");
      },
    });
    const ask = async () => {
      asked++;
      return undescribedModels;
    };

    await assert.rejects(catalog.refresh(context(store, false), ask), /offline/);
    assert.equal(asked, 1);
    assert.ok(store.entry, "the failed attempt is recorded");

    await catalog.refresh(context(store, false), ask);
    assert.equal(asked, 1);
    assert.deepEqual(catalog.getModels(), []);
  });

  it("keeps a confirmed allowlist that the built-ins can already describe when the fetch fails", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => {
        throw new Error("offline");
      },
    });
    await assert.rejects(catalog.refresh(context(store, false), advertises(dated)), /offline/);

    const restarted = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => {
        throw new Error("network must remain unused");
      },
    });
    await restarted.refresh(context(store, false), neverAsked);
    assert.deepEqual(
      restarted.getModels().map((model) => model.id),
      ["claude-haiku-4-5"],
      "the probe already confirmed the model, so a failed catalog fetch must not discard it",
    );
  });

  it("records the newly advertised allowlist when the fetch fails", async () => {
    const checkedAt = Date.parse("2026-07-24T00:00:00Z");
    const store = memoryStore({
      models: builtinModels,
      checkedAt,
      lastModified: checkedAt,
      supportedModelIds: ["claude-sonnet-5"],
    } as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => {
        throw new Error("offline");
      },
    });

    await assert.rejects(catalog.refresh(context(store, true), advertises(dated)), /offline/);
    assert.deepEqual(
      (store.entry as ModelsStoreEntry & { supportedModelIds: string[] }).supportedModelIds,
      ["claude-haiku-4-5"],
      "a failed fetch must not replay a stale allowlist on every later start",
    );
  });

  it("records failed attempts separately from successful checks", async () => {
    const checkedAt = Date.parse("2026-07-24T00:00:00Z");
    const failedAt = Date.parse("2026-07-25T00:00:00Z");
    const store = memoryStore({ models: builtinModels, checkedAt, lastModified: checkedAt });
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => failedAt,
      requestCatalog: async () => {
        throw new Error("offline");
      },
    });
    await assert.rejects(
      catalog.refresh(context(store, true), advertises(supportedModels)),
      /offline/,
    );
    assert.equal(store.entry?.checkedAt, checkedAt);
    assert.equal((store.entry as ModelsStoreEntry & { failedAt: number }).failedAt, failedAt);
  });

  it("offers a model Claude served but never advertised, and replays it on the next start", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5"],
    );

    await catalog.noteServedModel("claude-opus-4-8");
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5", "claude-opus-4-8"],
    );
    assert.deepEqual(
      (store.entry as ModelsStoreEntry & { observedModelIds: string[] }).observedModelIds,
      ["claude-opus-4-8"],
    );

    const restarted = createBridgeModelCatalog(testDependencies);
    await restarted.refresh(context(store, false), neverAsked);
    assert.deepEqual(
      restarted.getModels().map((model) => model.id),
      ["claude-opus-5", "claude-opus-4-8"],
    );
  });

  it("refetches when nothing on hand can describe a model Claude served", async () => {
    const checkedAt = Date.parse("2026-07-25T00:00:00Z");
    const store = memoryStore();
    let fetches = 0;
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => checkedAt,
      requestCatalog: async () => {
        fetches += 1;
        return response(
          fetches === 1 ? [...builtinModels, opus5] : [...builtinModels, opus5, future],
        );
      },
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));
    await catalog.noteServedModel("claude-opus-6");
    assert.equal(
      catalog.getModels().some((model) => model.id === "claude-opus-6"),
      false,
    );

    // The catalog on hand is minutes old, but it cannot name the model that just answered.
    await catalog.refresh({ ...context(store, true), force: false }, advertises(supportedModels));
    assert.equal(fetches, 2);
    assert.equal(
      catalog.getModels().some((model) => model.id === "claude-opus-6"),
      true,
    );
  });

  it("persists a served model with the confirmed allowlist, not as a never-probed entry", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));
    await catalog.noteServedModel("claude-opus-4-8");

    // A note that dropped supportedModelIds would read as a never-probed installation next start,
    // forcing discovery to collapse the catalog to the observed model alone.
    const persisted = store.entry as ModelsStoreEntry & {
      supportedModelIds: string[];
      observedModelIds: string[];
    };
    assert.deepEqual(persisted.supportedModelIds, ["claude-opus-5"]);
    assert.deepEqual(persisted.observedModelIds, ["claude-opus-4-8"]);

    const restarted = createBridgeModelCatalog(testDependencies);
    await restarted.refresh(context(store, false), neverAsked);
    assert.deepEqual(
      restarted.getModels().map((model) => model.id),
      ["claude-opus-5", "claude-opus-4-8"],
    );
  });

  it("keeps an observation that lands while the catalog is being refetched", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => {
        // Mid-fetch, Claude serves a model the catalog does not yet name.
        await catalog.noteServedModel("claude-opus-4-8");
        return response([...builtinModels, opus5]);
      },
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));

    const persisted = store.entry as ModelsStoreEntry & { observedModelIds: string[] };
    assert.deepEqual(
      persisted.observedModelIds,
      ["claude-opus-4-8"],
      "the refresh write must not clobber a concurrent observation",
    );
  });

  it("keeps persisting after a single store write fails", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));

    let failNext = true;
    store.write = async function (entry) {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      this.entry = structuredClone(entry);
    };
    await assert.rejects(catalog.noteServedModel("claude-opus-4-8"), /disk full/);
    // A poisoned write chain would silently skip this second write; it must still land.
    await catalog.noteServedModel("claude-sonnet-5");
    assert.deepEqual(
      (store.entry as ModelsStoreEntry & { observedModelIds: string[] }).observedModelIds,
      ["claude-opus-4-8", "claude-sonnet-5"],
    );
  });

  it("ignores a served name that identifies no model family", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));

    await catalog.noteServedModel("sonnet");
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5"],
    );
    assert.deepEqual(
      (store.entry as ModelsStoreEntry & { observedModelIds: string[] }).observedModelIds,
      [],
    );
  });

  it("rejects malformed remote metadata without replacing the baseline", async () => {
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () =>
        new Response(JSON.stringify([{ id: "claude-opus-5" }]), { status: 200 }),
    });
    await assert.rejects(
      catalog.refresh(context(memoryStore(), true), advertises(undescribedModels)),
      /malformed metadata/,
    );
    assert.deepEqual(catalog.getModels(), []);
  });
});
