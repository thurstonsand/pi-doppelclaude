import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
} from "@earendil-works/pi-ai/providers/all";
import { type Static, Type } from "typebox";
import { debug } from "./debug.js";
import {
  type AdvertisedModel,
  type BridgeModel,
  canonicalClaudeModelId,
  compareModels,
  isStableClaudeModelId,
  projectCatalogModels,
  synthesizeModel,
} from "./models.js";
import { parseValue } from "./validation.js";

const CATALOG_URL = "https://pi.dev/api/models/providers/anthropic";
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Matches pi's built-in metadata refresh time
const CATALOG_TIMEOUT_MS = 15_000;

const RATE_SCHEMA = Type.Number({ minimum: 0 });
const COST_RATES_SCHEMA = {
  input: RATE_SCHEMA,
  output: RATE_SCHEMA,
  cacheRead: RATE_SCHEMA,
  cacheWrite: RATE_SCHEMA,
};
const COST_SCHEMA = Type.Object({
  ...COST_RATES_SCHEMA,
  tiers: Type.Optional(
    Type.Array(
      Type.Object({
        inputTokensAbove: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        ...COST_RATES_SCHEMA,
      }),
    ),
  ),
});
const CANONICAL_MODEL_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  api: Type.Literal("anthropic-messages"),
  provider: Type.Literal("anthropic"),
  baseUrl: Type.String({ minLength: 1 }),
  reasoning: Type.Boolean(),
  thinkingLevelMap: Type.Optional(
    Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
  ),
  input: Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")])),
  cost: COST_SCHEMA,
  contextWindow: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  maxTokens: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const CANONICAL_MODELS_SCHEMA = Type.Array(CANONICAL_MODEL_SCHEMA);
const CATALOG_SCHEMA = Type.Union([
  CANONICAL_MODELS_SCHEMA,
  Type.Object({ models: CANONICAL_MODELS_SCHEMA }),
  Type.Record(Type.String(), CANONICAL_MODEL_SCHEMA),
]);
const ADVERTISED_MODEL_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  supportedEffortLevels: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
  ),
  supportsAdaptiveThinking: Type.Optional(Type.Boolean()),
});
const STORE_ENTRY_SCHEMA = Type.Object({
  models: CANONICAL_MODELS_SCHEMA,
  checkedAt: Type.Optional(Type.Number()),
  lastModified: Type.Optional(Type.Number()),
  etag: Type.Optional(Type.String()),
  supportedModelIds: Type.Optional(Type.Array(Type.String())),
  observedModelIds: Type.Optional(Type.Array(Type.String())),
  advertisedModels: Type.Optional(Type.Array(ADVERTISED_MODEL_SCHEMA)),
});

type CanonicalModel = Static<typeof CANONICAL_MODEL_SCHEMA>;
type StoredCatalog = Static<typeof STORE_ENTRY_SCHEMA>;

export interface ModelCatalogDependencies {
  requestCatalog(signal: AbortSignal, etag?: string): Promise<Response>;
  now(): number;
  builtinGeneratedAt: number | undefined;
  builtinModels: readonly Model<Api>[];
}

function parseCanonicalModels(value: unknown): CanonicalModel[] {
  const catalog = parseValue(
    CATALOG_SCHEMA,
    value,
    "Pi returned malformed metadata in the Anthropic model catalog",
  );
  if (Array.isArray(catalog)) return catalog;
  if ("models" in catalog && Array.isArray(catalog.models)) return catalog.models;
  return Object.values(catalog) as CanonicalModel[];
}

// The store is untrusted input. A Pi upgrade, a hand edit, or a torn write must not strand the provider with an empty
// catalog on every start, so an unusable entry is discarded and the next refresh rediscovers it.
function parseStoreEntry(value: unknown): StoredCatalog | undefined {
  if (value === undefined) return undefined;
  try {
    return parseValue(
      STORE_ENTRY_SCHEMA,
      value,
      "Pi's cached Anthropic model catalog is malformed",
    );
  } catch (error) {
    debug("model-catalog: discarding an unusable store entry", error);
    return undefined;
  }
}

// Claude Code advertises a model under whichever name it currently prefers: a mutable alias
// (`sonnet`), a long-context form, or a dated snapshot. Mutable aliases name no family, so they
// fail the stable-ID test and never reach the catalog.
function advertisedModels(models: readonly ModelInfo[]): Map<string, AdvertisedModel> {
  const rows = new Map<string, AdvertisedModel>();
  const add = (advertised: string, row: ModelInfo, named: boolean) => {
    const id = canonicalClaudeModelId(advertised);
    // The bare and `[1m]` rows of one model collapse onto the same id; either describes it.
    if (!isStableClaudeModelId(id) || rows.has(id)) return;
    rows.set(id, {
      displayName: named ? row.displayName : id,
      ...(row.supportedEffortLevels ? { supportedEffortLevels: row.supportedEffortLevels } : {}),
      ...(row.supportsAdaptiveThinking === undefined
        ? {}
        : { supportsAdaptiveThinking: row.supportsAdaptiveThinking }),
    });
  };
  // `default` is the account's current preference rather than a model
  const sentinel = (model: ModelInfo) => model.value === "default";
  for (const model of models.filter((model) => !sentinel(model))) {
    if (model.resolvedModel) add(model.resolvedModel, model, true);
    add(model.value, model, true);
  }
  for (const model of models.filter(sentinel)) {
    if (model.resolvedModel) add(model.resolvedModel, model, false);
  }
  return rows;
}

function storedAdvertisedModels(entry: StoredCatalog | undefined): Map<string, AdvertisedModel> {
  return new Map((entry?.advertisedModels ?? []).map(({ id, ...row }) => [id, row]));
}

function advertisedModelList(rows: ReadonlyMap<string, AdvertisedModel>) {
  return [...rows]
    .map(([id, row]) => ({ id, ...row }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sameModelIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export interface BridgeModelCatalog {
  getModels(): readonly BridgeModel[];
  /**
   * Claude can serve a model it never advertised. Nothing else will ever name it, so the model
   * that answered is taken as its own evidence: it joins the allowlist, appears in `/models`
   * immediately, and is replayed on the next start.
   */
  noteServedModel(id: string): Promise<void>;
  /**
   * `requestSupportedModels` asks Claude Code what it serves, which costs a full CLI boot. The
   * catalog calls it only when it cannot answer from the store, so the caller supplies the
   * capability and the catalog owns the decision to spend it.
   */
  refresh(
    context: RefreshModelsContext,
    requestSupportedModels: () => Promise<readonly ModelInfo[]>,
  ): Promise<void>;
}

function defaultDependencies(): ModelCatalogDependencies {
  return {
    requestCatalog: (signal, etag) =>
      fetch(CATALOG_URL, {
        headers: { accept: "application/json", ...(etag ? { "if-none-match": etag } : {}) },
        signal,
      }),
    now: Date.now,
    builtinGeneratedAt: getBuiltinModelDataGeneratedAt(),
    builtinModels: getBuiltinModels("anthropic"),
  };
}

export function createBridgeModelCatalog(
  dependencies: ModelCatalogDependencies = defaultDependencies(),
): BridgeModelCatalog {
  let models: readonly BridgeModel[] = [];
  let overlayModels: readonly Model<Api>[] = [];
  let advertisedIds: ReadonlySet<string> = new Set();
  let advertisedRows: ReadonlyMap<string, AdvertisedModel> = new Map();
  let describedIds: ReadonlySet<string> = new Set();
  const observedIds = new Set<string>();
  let dynamicLastModified = -1;
  // Pi owns storage and mints a fresh generation-fenced publish capability per refresh, so the
  // current capability doubles as the supersession token: keeping the latest one lets a model
  // first observed mid-turn persist immediately, and a persist built by an older refresh compares
  // unequal and is dropped before it can clobber a newer refresh's entry. Building the entry,
  // updating the shadow, and calling publish share one synchronous step, so call order and pi's
  // per-provider publication chain agree on the final entry even when writers overlap.
  let storedCatalog: StoredCatalog | undefined;
  let publish: RefreshModelsContext["publish"] | undefined;
  const persist = (
    target: RefreshModelsContext["publish"],
    entry: StoredCatalog,
    update?: () => void,
  ): Promise<boolean> => {
    if (target !== publish) return Promise.resolve(false);
    storedCatalog = entry;
    return target({ persist: entry, update });
  };

  // A synthesized entry is the floor, Pi's bundled metadata overrides it, and a canonical catalog
  // overrides that, so a model Claude Code confirmed is offered whether or not anyone can describe
  // it, and gets described the moment someone can.
  const project = () => {
    const allowedIds = new Set([...advertisedIds, ...observedIds]);
    const merged = new Map<string, BridgeModel>();
    for (const id of allowedIds) {
      if (!isStableClaudeModelId(id)) continue;
      // A model Claude Code served without advertising, or one allowlisted by a store entry written
      // before descriptions were kept, has only its id to go by.
      merged.set(id, synthesizeModel(id, advertisedRows.get(id) ?? { displayName: id }));
    }
    const described = new Set<string>();
    for (const source of [dependencies.builtinModels, overlayModels]) {
      for (const model of projectCatalogModels(source, allowedIds)) {
        merged.set(model.id, model);
        described.add(model.id);
      }
    }
    describedIds = described;
    models = [...merged.values()].sort(compareModels);
  };

  // Applied only inside a publish `update`, so pi's generation fence has already ruled out a
  // superseded refresh installing an older allowlist or overlay.
  const applyModels = (
    overlay: readonly Model<Api>[],
    allowedIds: ReadonlySet<string>,
    rows: ReadonlyMap<string, AdvertisedModel>,
    lastModified: number,
  ) => {
    advertisedIds = allowedIds;
    advertisedRows = rows;
    if (lastModified >= dynamicLastModified) {
      overlayModels = overlay;
      dynamicLastModified = lastModified;
    }
    project();
  };

  // A cached catalog no newer than the built-ins it would override has nothing left to contribute.
  const overlayFor = (entry: StoredCatalog | undefined): StoredCatalog | undefined => {
    if (!entry) return undefined;
    if (
      dependencies.builtinGeneratedAt !== undefined &&
      (entry.lastModified === undefined || entry.lastModified <= dependencies.builtinGeneratedAt)
    )
      return undefined;
    return entry;
  };

  // `undefined` reports a 304: the validated catalog is unchanged, so the cached body stands.
  const fetchCatalog = async (
    signal: AbortSignal,
    validator: string | undefined,
  ): Promise<StoredCatalog | undefined> => {
    const response = await dependencies.requestCatalog(
      AbortSignal.any([signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
      validator,
    );
    if (validator !== undefined && response.status === 304) return undefined;
    if (!response.ok)
      throw new Error(`Pi Anthropic model catalog request failed: ${response.status}`);
    const canonical = parseCanonicalModels(await response.json());
    const parsedLastModified = Date.parse(response.headers.get("last-modified") ?? "");
    return {
      models: canonical,
      checkedAt: dependencies.now(),
      lastModified: Number.isNaN(parsedLastModified) ? 0 : parsedLastModified,
      etag: response.headers.get("etag") ?? undefined,
    };
  };

  return {
    getModels: () => models,
    async noteServedModel(id) {
      if (!isStableClaudeModelId(id) || observedIds.has(id)) return;
      observedIds.add(id);
      project();
      debug(
        `model-catalog: observed served model ${id}${models.some((model) => model.id === id) ? "" : " (undescribed)"}`,
      );
      if (!publish) return;
      // An entry with no `supportedModelIds` reads as a never-probed installation on the next start,
      // collapsing the catalog to observed models only, so the confirmed allowlist is carried too.
      const stored = storedCatalog;
      await persist(publish, {
        ...(stored ?? { models: [] }),
        supportedModelIds: stored?.supportedModelIds ?? [...advertisedIds].sort(),
        advertisedModels: stored?.advertisedModels ?? advertisedModelList(advertisedRows),
        observedModelIds: [...observedIds].sort(),
      });
    },
    // Pi replays this refresh with `allowNetwork: false` on every start, so the offline branch
    // is the whole cold-start catalog: newly shipped built-ins plus the last canonical fetch,
    // both narrowed by the allowlist Claude Code confirmed the last time it was asked.
    async refresh(context, requestSupportedModels) {
      const stored = parseStoreEntry(context.stored);
      publish = context.publish;
      storedCatalog = stored;
      for (const id of stored?.observedModelIds ?? []) observedIds.add(id);
      // An installation that has never asked Claude Code has no allowlist to replay, so its first
      // refresh discovers even while Pi is only replaying caches. Once the probe answers, a fetched
      // and a failed catalog both write an entry, so a bootstrapped installation never discovers on
      // startup again. A probe that never answered leaves it unbootstrapped for the next start.
      const discovering = context.allowNetwork || stored === undefined;
      const rows = discovering
        ? advertisedModels(await requestSupportedModels())
        : storedAdvertisedModels(stored);
      const allowedIds = discovering
        ? new Set(rows.keys())
        : new Set(stored?.supportedModelIds ?? []);
      const overlay = overlayFor(stored);
      const restored = await context.publish({
        update: () =>
          applyModels(
            overlay?.models ?? [],
            allowedIds,
            rows,
            overlay?.lastModified ?? dependencies.builtinGeneratedAt ?? 0,
          ),
      });
      if (!discovering || !restored) return;

      const supportedModelIds = [...allowedIds].sort();
      const advertised = advertisedModelList(rows);
      // Claude Code can begin serving a model that neither the built-ins nor the cached catalog
      // describe. An allowlist entry alone cannot surface it, so freshness yields to a refetch.
      const undescribed = [...supportedModelIds, ...observedIds].some(
        (id) => !describedIds.has(id),
      );
      if (
        !context.force &&
        !undescribed &&
        stored?.lastModified !== undefined &&
        dependencies.now() - (stored.checkedAt ?? 0) < REFRESH_INTERVAL_MS
      ) {
        // A still-fresh canonical catalog must record what Claude Code just advertised, or the
        // next cold start replays a stale allowlist and drops a newly served model.
        if (!sameModelIds(stored.supportedModelIds, supportedModelIds)) {
          await persist(context.publish, {
            ...(storedCatalog ?? stored),
            supportedModelIds,
            advertisedModels: advertised,
            observedModelIds: [...observedIds].sort(),
          });
        }
        return;
      }

      try {
        // Only revalidate when a cached body backs the validator, so a 304 can never leave the
        // catalog empty.
        const validator = stored?.models.length ? stored.etag : undefined;
        const canonicalEntry = await fetchCatalog(context.signal, validator);
        if (canonicalEntry === undefined) {
          // Unchanged: the restore already applied the cached overlay, so only the freshness
          // window and the allowlist move.
          await persist(context.publish, {
            ...(storedCatalog ?? stored ?? { models: [] }),
            supportedModelIds,
            advertisedModels: advertised,
            observedModelIds: [...observedIds].sort(),
            checkedAt: dependencies.now(),
          });
          return;
        }
        // An observation that landed during the fetch is already in `observedIds`, so this write
        // carries it instead of overwriting it with a pre-fetch snapshot.
        await persist(
          context.publish,
          {
            ...canonicalEntry,
            supportedModelIds,
            advertisedModels: advertised,
            observedModelIds: [...observedIds].sort(),
          },
          () =>
            applyModels(canonicalEntry.models, allowedIds, rows, canonicalEntry.lastModified ?? 0),
        );
      } catch (error) {
        if (!context.signal.aborted) {
          // The probe already confirmed this allowlist. Dropping it here would strand later starts
          // on an empty catalog, or replay a stale one, over models the built-ins can describe.
          // Stamping `checkedAt` on the failure throttles retries, matching pi's own catalog flow.
          await persist(context.publish, {
            ...(storedCatalog ?? { models: [] }),
            supportedModelIds,
            advertisedModels: advertised,
            observedModelIds: [...observedIds].sort(),
            checkedAt: dependencies.now(),
          });
        }
        throw error;
      }
    },
  };
}
