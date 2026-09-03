import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
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

interface MemoryStore {
  entry?: ModelsStoreEntry;
  write(entry: ModelsStoreEntry): Promise<void>;
}

function memoryStore(initial?: ModelsStoreEntry): MemoryStore {
  return {
    entry: initial,
    async write(entry) {
      this.entry = structuredClone(entry);
    },
  };
}

function context(store: MemoryStore, allowNetwork: boolean): RefreshModelsContext {
  return {
    stored: store.entry,
    allowNetwork,
    force: true,
    signal: new AbortController().signal,
    async publish(publication) {
      if (publication.persist === null) store.entry = undefined;
      else if (publication.persist !== undefined) await store.write(publication.persist);
      publication.update?.();
      return true;
    },
  };
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
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-99"],
      "Claude Code confirmed the model, so a catalog nobody could fetch does not hide it",
    );
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

  it("stamps a failed attempt as the last check so retries are throttled", async () => {
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
    assert.equal(store.entry?.checkedAt, failedAt);
    assert.equal(store.entry?.lastModified, checkedAt, "the cached catalog survives the failure");
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
    assert.deepEqual(
      required(
        catalog.getModels().find((model) => model.id === "claude-opus-6"),
        "the served model to be offered on synthesized metadata",
      ).cost,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );

    // The catalog on hand is minutes old, but it cannot name the model that just answered.
    await catalog.refresh({ ...context(store, true), force: false }, advertises(supportedModels));
    assert.equal(fetches, 2);
    assert.deepEqual(
      required(
        catalog.getModels().find((model) => model.id === "claude-opus-6"),
        "the served model to survive the refetch",
      ).cost,
      future.cost,
      "a described model supersedes the synthesized one",
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
    // A failed write must not wedge later persists; this second write must still land.
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

  it("stores the catalog validator, sending none while no cached body backs one", async () => {
    const store = memoryStore();
    let sentValidator: string | undefined = "unset";
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async (_signal, etag) => {
        sentValidator = etag;
        return new Response(JSON.stringify([...builtinModels, opus5]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "last-modified": "Fri, 24 Jul 2026 19:15:06 GMT",
            etag: '"catalog-v1"',
          },
        });
      },
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));
    assert.equal(sentValidator, undefined, "no cached body backs a validator yet");
    assert.equal(store.entry?.etag, '"catalog-v1"');
  });

  it("moves only the freshness window when the catalog answers 304", async () => {
    const checkedAt = Date.parse("2026-07-20T00:00:00Z");
    const revalidatedAt = Date.parse("2026-07-25T00:00:00Z");
    const store = memoryStore({
      models: [...builtinModels, opus5],
      checkedAt,
      lastModified: Date.parse("2026-07-24T19:15:06Z"),
      etag: '"catalog-v1"',
      supportedModelIds: ["claude-opus-5"],
    } as ModelsStoreEntry);
    let sentValidator: string | undefined;
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => revalidatedAt,
      requestCatalog: async (_signal, etag) => {
        sentValidator = etag;
        return new Response(null, { status: 304 });
      },
    });
    await catalog.refresh(context(store, true), advertises(supportedModels));
    assert.equal(sentValidator, '"catalog-v1"');
    assert.equal(store.entry?.checkedAt, revalidatedAt);
    assert.equal(store.entry?.etag, '"catalog-v1"');
    assert.ok(
      store.entry?.models.some((model) => model.id === "claude-opus-5"),
      "the cached body survives revalidation",
    );
    assert.ok(catalog.getModels().some((model) => model.id === "claude-opus-5"));
  });

  it("stops when pi reports the restore publication superseded", async () => {
    let asked = 0;
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => {
        throw new Error("a superseded refresh must not fetch");
      },
    });
    const superseded: RefreshModelsContext = {
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      async publish() {
        return false;
      },
    };
    await catalog.refresh(superseded, async () => {
      asked++;
      return supportedModels;
    });
    assert.equal(asked, 1, "discovery precedes the restore publication");
    assert.deepEqual(catalog.getModels(), [], "a refused update must not be applied");
  });

  it("drops a stale refresh's write instead of clobbering a newer one", async () => {
    let releaseFetch = () => {};
    let reachedFetch = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    // The stale refresh has to get past its own restore before the newer one starts, or the race
    // under test never happens.
    const inFlight = new Promise<void>((resolve) => {
      reachedFetch = resolve;
    });
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      now: () => Date.parse("2026-07-25T00:00:00Z"),
      requestCatalog: async () => {
        reachedFetch();
        await gate;
        return response([...builtinModels, opus5, future]);
      },
    });

    const staleStore = memoryStore();
    const staleRefresh = catalog.refresh(
      context(staleStore, true),
      advertises([...supportedModels, { ...supportedModels[0], resolvedModel: "claude-opus-6" }]),
    );
    await inFlight;

    const newerStore = memoryStore({
      models: [...builtinModels, opus5],
      checkedAt: Date.parse("2026-07-25T00:00:00Z"),
      lastModified: Date.parse("2026-07-24T19:15:06Z"),
      supportedModelIds: ["claude-opus-5"],
    } as ModelsStoreEntry);
    await catalog.refresh(context(newerStore, false), neverAsked);

    releaseFetch();
    await staleRefresh;
    assert.equal(staleStore.entry, undefined, "the stale refresh must not persist");
    assert.deepEqual(
      catalog.getModels().map((model) => model.id),
      ["claude-opus-5"],
      "the stale refresh's fetched catalog must not be applied",
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
    assert.deepEqual(
      catalog.getModels().map((model) => model.name),
      ["Opus"],
      "nothing from the malformed body describes the synthesized model",
    );
  });
});

describe("models Pi cannot describe yet", () => {
  const newlyShipped: ModelInfo[] = [
    {
      value: "opus[1m]",
      resolvedModel: "claude-opus-99[1m]",
      displayName: "Opus 99",
      description: "The one Pi has not heard of",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      supportsAdaptiveThinking: true,
    },
  ];

  it("offers it on what Claude Code said about it", async () => {
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response(builtinModels),
    });
    await catalog.refresh(context(memoryStore(), true), advertises(newlyShipped));

    const synthesized = required(
      catalog.getModels().find((model) => model.id === "claude-opus-99"),
      "the catalog to offer a model nothing describes",
    );
    assert.equal(synthesized.name, "Opus 99");
    assert.equal(synthesized.provider, PROVIDER_ID);
    assert.equal(claudeCodeModelId(synthesized), "claude-opus-99[1m]");
    assert.equal(synthesized.maxTokens, 64_000);
    assert.deepEqual(synthesized.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(synthesized.thinkingLevelMap, {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    });
  });

  it("never takes its name from Claude Code's default row", async () => {
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response(builtinModels),
    });
    await catalog.refresh(
      context(memoryStore(), true),
      advertises([
        {
          value: "default",
          resolvedModel: "claude-opus-99[1m]",
          displayName: "Default (recommended)",
          description: "",
        },
        {
          value: "opus[1m]",
          resolvedModel: "claude-opus-99[1m]",
          displayName: "Opus (1M context)",
          description: "",
        },
      ]),
    );
    assert.deepEqual(
      catalog.getModels().map((model) => model.name),
      ["Opus (1M context)"],
    );
  });

  it("still admits a model only the default row names, under its id", async () => {
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response(builtinModels),
    });
    await catalog.refresh(
      context(memoryStore(), true),
      advertises([
        {
          value: "default",
          resolvedModel: "claude-opus-99[1m]",
          displayName: "Default (recommended)",
          description: "",
          supportedEffortLevels: ["low", "max"],
        },
      ]),
    );
    const admitted = required(
      catalog.getModels().find((model) => model.id === "claude-opus-99"),
      "a model named by nothing but the default row to still be offered",
    );
    assert.equal(admitted.name, "claude-opus-99");
    assert.deepEqual(
      admitted.thinkingLevelMap,
      { low: "low", max: "max" },
      "the default row still describes whatever it points at",
    );
  });

  it("yields to the canonical entry the moment one describes it", async () => {
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response([...builtinModels, opus5]),
    });
    await catalog.refresh(context(memoryStore(), true), advertises(supportedModels));
    const described = required(
      catalog.getModels().find((model) => model.id === "claude-opus-5"),
      "the catalog to describe claude-opus-5",
    );
    assert.equal(described.name, "Claude Opus 5", "the advertised display name does not win");
    assert.deepEqual(described.cost, opus5.cost);
  });

  it("replays what Claude Code said on a cold offline start", async () => {
    const store = memoryStore();
    const catalog = createBridgeModelCatalog({
      ...testDependencies,
      requestCatalog: async () => response(builtinModels),
    });
    await catalog.refresh(context(store, true), advertises(newlyShipped));

    const restarted = createBridgeModelCatalog(testDependencies);
    await restarted.refresh(context(store, false), neverAsked);
    assert.equal(
      required(
        restarted.getModels().find((model) => model.id === "claude-opus-99"),
        "the synthesized model to survive a restart",
      ).name,
      "Opus 99",
    );
  });

  it("falls back to the id when the store predates advertised descriptions", async () => {
    const store = memoryStore({
      models: builtinModels,
      checkedAt: Date.parse("2026-07-25T00:00:00Z"),
      lastModified: Date.parse("2026-07-24T19:15:06Z"),
      supportedModelIds: ["claude-opus-99"],
    } as ModelsStoreEntry);
    const catalog = createBridgeModelCatalog(testDependencies);
    await catalog.refresh(context(store, false), neverAsked);
    assert.equal(
      required(
        catalog.getModels().find((model) => model.id === "claude-opus-99"),
        "an allowlisted model with no description to still be offered",
      ).name,
      "claude-opus-99",
    );
  });
});
