import type { Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { type Static, Type } from "typebox";
import {
	compareModels,
	isStableClaudeModelId,
	projectCatalogModels,
	type BridgeModel,
} from "./models.js";
import { debug } from "./debug.js";
import { parseValue } from "./validation.js";

const CATALOG_URL = "https://pi.dev/api/models/providers/anthropic";
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const RATE_SCHEMA = Type.Number({ minimum: 0 });
const COST_RATES_SCHEMA = {
	input: RATE_SCHEMA,
	output: RATE_SCHEMA,
	cacheRead: RATE_SCHEMA,
	cacheWrite: RATE_SCHEMA,
};
const COST_SCHEMA = Type.Object({
	...COST_RATES_SCHEMA,
	tiers: Type.Optional(Type.Array(Type.Object({
		inputTokensAbove: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		...COST_RATES_SCHEMA,
	}))),
});
const CANONICAL_MODEL_SCHEMA = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	api: Type.Literal("anthropic-messages"),
	provider: Type.Literal("anthropic"),
	baseUrl: Type.String({ minLength: 1 }),
	reasoning: Type.Boolean(),
	thinkingLevelMap: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
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
const STORE_ENTRY_SCHEMA = Type.Object({
	models: CANONICAL_MODELS_SCHEMA,
	checkedAt: Type.Optional(Type.Number()),
	failedAt: Type.Optional(Type.Number()),
	lastModified: Type.Optional(Type.Number()),
	supportedModelIds: Type.Optional(Type.Array(Type.String())),
});

type CanonicalModel = Static<typeof CANONICAL_MODEL_SCHEMA>;
type StoredCatalog = Static<typeof STORE_ENTRY_SCHEMA>;

export interface ModelCatalogDependencies {
	requestCatalog(signal?: AbortSignal): Promise<Response>;
	now(): number;
	builtinGeneratedAt: number | undefined;
	builtinModels: readonly Model<any>[];
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
		return parseValue(STORE_ENTRY_SCHEMA, value, "Pi's cached Anthropic model catalog is malformed");
	} catch (error) {
		debug("model-catalog: discarding an unusable store entry", error);
		return undefined;
	}
}

// Claude Code advertises a model under whichever name it currently prefers: a mutable alias
// (`sonnet`), a long-context form (`claude-opus-5[1m]`), or a dated snapshot
// (`claude-haiku-4-5-20251001`). A snapshot names its family, and the family ID is the one Pi
// describes, persists in sessions, and Claude Code serves, so snapshots normalize onto it.
// Mutable aliases name no family, so they fail the stable-ID test and never reach the catalog.
function advertisedModelIds(models: readonly ModelInfo[]): Set<string> {
	const ids = new Set<string>();
	const add = (advertised: string) => {
		const id = advertised.replace(/\[1m\]$/u, "").replace(/-\d{8}$/u, "");
		if (isStableClaudeModelId(id)) ids.add(id);
	};
	for (const model of models) {
		if (model.resolvedModel) add(model.resolvedModel);
		add(model.value);
	}
	return ids;
}

function sameModelIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
	return left !== undefined && left.length === right.length && left.every((id, index) => id === right[index]);
}

export interface BridgeModelCatalog {
	getModels(): readonly BridgeModel[];
	/**
	 * `requestSupportedModels` asks Claude Code what it serves, which costs a full CLI boot. The
	 * catalog calls it only when it cannot answer from the store, so the caller supplies the
	 * capability and the catalog owns the decision to spend it.
	 */
	refresh(context: RefreshModelsContext, requestSupportedModels: () => Promise<readonly ModelInfo[]>): Promise<void>;
}

function defaultDependencies(): ModelCatalogDependencies {
	return {
		requestCatalog: (signal) => fetch(CATALOG_URL, { headers: { accept: "application/json" }, signal }),
		now: Date.now,
		builtinGeneratedAt: getBuiltinModelDataGeneratedAt(),
		builtinModels: getBuiltinModels("anthropic"),
	};
}

export function createBridgeModelCatalog(dependencies: ModelCatalogDependencies = defaultDependencies()): BridgeModelCatalog {
	let models: readonly BridgeModel[] = [];
	let dynamicLastModified = -1;

	// Pi's bundled metadata is the floor and a canonical catalog overlays it, so a model Claude Code
	// confirmed is offered as soon as either source can describe it.
	const applyModels = (overlay: readonly Model<any>[], allowedIds: ReadonlySet<string>, lastModified: number) => {
		if (lastModified < dynamicLastModified) return;
		const merged = new Map(projectCatalogModels(dependencies.builtinModels, allowedIds).map((model) => [model.id, model]));
		for (const model of projectCatalogModels(overlay, allowedIds)) merged.set(model.id, model);
		models = [...merged.values()].sort(compareModels);
		dynamicLastModified = lastModified;
	};

	// A cached catalog no newer than the built-ins it would override has nothing left to contribute.
	const overlayFor = (entry: StoredCatalog | undefined): StoredCatalog | undefined => {
		if (!entry) return undefined;
		if (
			dependencies.builtinGeneratedAt !== undefined &&
			(entry.lastModified === undefined || entry.lastModified <= dependencies.builtinGeneratedAt)
		) return undefined;
		return entry;
	};

	const fetchCatalog = async (signal?: AbortSignal): Promise<StoredCatalog> => {
		const response = await dependencies.requestCatalog(signal);
		if (!response.ok) throw new Error(`Pi Anthropic model catalog request failed: ${response.status}`);
		const canonical = parseCanonicalModels(await response.json());
		const parsedLastModified = Date.parse(response.headers.get("last-modified") ?? "");
		return {
			models: canonical,
			checkedAt: dependencies.now(),
			lastModified: Number.isNaN(parsedLastModified) ? 0 : parsedLastModified,
		};
	};

	return {
		getModels: () => models,
		// Pi replays this refresh with `allowNetwork: false` on every start, so the offline branch
		// is the whole cold-start catalog: newly shipped built-ins plus the last canonical fetch,
		// both narrowed by the allowlist Claude Code confirmed the last time it was asked.
		async refresh(context, requestSupportedModels) {
			const stored = parseStoreEntry(await context.store.read());
			// An installation that has never asked Claude Code has no allowlist to replay, so its first
			// refresh discovers even while Pi is only replaying caches. Once the probe answers, a fetched
			// and a failed catalog both write an entry, so a bootstrapped installation never discovers on
			// startup again. A probe that never answered leaves it unbootstrapped for the next start.
			const discovering = context.allowNetwork || stored === undefined;
			const allowedIds = discovering
				? advertisedModelIds(await requestSupportedModels())
				: new Set(stored?.supportedModelIds ?? []);
			const overlay = overlayFor(stored);
			applyModels(overlay?.models ?? [], allowedIds, overlay?.lastModified ?? dependencies.builtinGeneratedAt ?? 0);
			if (!discovering || context.signal?.aborted) return;

			const supportedModelIds = [...allowedIds].sort();
			const lastAttemptAt = Math.max(stored?.checkedAt ?? 0, stored?.failedAt ?? 0);
			// Claude Code can begin serving a model that neither the built-ins nor the cached catalog
			// describe. An allowlist entry alone cannot surface it, so freshness yields to a refetch.
			const undescribed = supportedModelIds.some((id) => !models.some((model) => model.id === id));
			if (
				!context.force &&
				!undescribed &&
				stored?.lastModified !== undefined &&
				dependencies.now() - lastAttemptAt < REFRESH_INTERVAL_MS
			) {
				// A still-fresh canonical catalog must record what Claude Code just advertised, or the
				// next cold start replays a stale allowlist and drops a newly served model.
				if (!sameModelIds(stored.supportedModelIds, supportedModelIds)) {
					await context.store.write({ ...stored, supportedModelIds } as ModelsStoreEntry);
				}
				return;
			}

			try {
				const canonicalEntry = await fetchCatalog(context.signal);
				if (context.signal?.aborted) return;
				const entry: StoredCatalog = { ...canonicalEntry, supportedModelIds };
				applyModels(entry.models, allowedIds, entry.lastModified ?? 0);
				await context.store.write(entry as ModelsStoreEntry);
			} catch (error) {
				if (!context.signal?.aborted) {
					// The probe already confirmed this allowlist. Dropping it here would strand later starts
					// on an empty catalog, or replay a stale one, over models the built-ins can describe.
					await context.store.write({
						...(stored ?? { models: [] }),
						supportedModelIds,
						failedAt: dependencies.now(),
					} as ModelsStoreEntry);
				}
				throw error;
			}
		},
	};
}
