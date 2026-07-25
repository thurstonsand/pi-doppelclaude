import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { type Static, Type } from "typebox";
import {
	buildModels,
	compareModels,
	isStableClaudeModelId,
	MODEL_IDS_IN_ORDER,
	projectCatalogModels,
	type BridgeModel,
} from "./models.js";
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
	readSharedCatalog(): Promise<unknown>;
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

function parseStoreEntry(value: unknown): StoredCatalog | undefined {
	if (value === undefined) return undefined;
	return parseValue(STORE_ENTRY_SCHEMA, value, "Pi's cached Anthropic model catalog is malformed");
}

function advertisedModelIds(models: readonly ModelInfo[]): Set<string> {
	const ids = new Set<string>();
	for (const model of models) {
		const resolved = model.resolvedModel?.replace(/\[1m\]$/u, "");
		if (resolved) ids.add(resolved);
		const value = model.value.replace(/\[1m\]$/u, "");
		if (value.startsWith("claude-")) ids.add(value);
	}
	return ids;
}

function allowedModelIds(supportedModels: readonly ModelInfo[]): Set<string> {
	const ids = advertisedModelIds(supportedModels);
	for (const id of MODEL_IDS_IN_ORDER) ids.add(id);
	return ids;
}

function storedAllowedModelIds(entry: StoredCatalog): Set<string> {
	const ids = new Set(entry.supportedModelIds ?? []);
	for (const id of MODEL_IDS_IN_ORDER) ids.add(id);
	return ids;
}

// `pi update --models` refreshes built-in providers without loading extensions. Read its
// documented shared cache so dynamic bridge models exist before CLI model selection.
async function readSharedCatalog(): Promise<unknown> {
	let content: string;
	try {
		content = await readFile(join(getAgentDir(), "models-store.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const store = parseValue(
		Type.Record(Type.String(), Type.Unknown()),
		JSON.parse(content),
		"Pi's model catalog store is malformed",
	);
	return parseStoreEntry(store.anthropic);
}

export interface BridgeModelCatalog {
	getModels(): readonly BridgeModel[];
	initialize(supportedModels: readonly ModelInfo[]): Promise<void>;
	refresh(context: RefreshModelsContext, supportedModels: readonly ModelInfo[]): Promise<void>;
}

function defaultDependencies(): ModelCatalogDependencies {
	return {
		requestCatalog: (signal) => fetch(CATALOG_URL, { headers: { accept: "application/json" }, signal }),
		now: Date.now,
		builtinGeneratedAt: getBuiltinModelDataGeneratedAt(),
		builtinModels: getBuiltinModels("anthropic"),
		readSharedCatalog,
	};
}

export function createBridgeModelCatalog(dependencies: ModelCatalogDependencies = defaultDependencies()): BridgeModelCatalog {
	const baseline = buildModels(dependencies.builtinModels);
	let models: readonly BridgeModel[] = baseline;
	let dynamicLastModified = -1;

	const applyModels = (canonical: readonly Model<any>[], allowedIds: ReadonlySet<string>, lastModified: number) => {
		if (lastModified < dynamicLastModified) return;
		const merged = new Map(baseline.map((model) => [model.id, model]));
		for (const model of projectCatalogModels(canonical, allowedIds)) merged.set(model.id, model);
		models = [...merged.values()].sort(compareModels);
		dynamicLastModified = lastModified;
	};

	const applyStoredEntry = (entry: StoredCatalog | undefined, allowedIds: ReadonlySet<string>) => {
		if (!entry) return;
		if (
			dependencies.builtinGeneratedAt !== undefined &&
			(entry.lastModified === undefined || entry.lastModified <= dependencies.builtinGeneratedAt)
		) return;
		applyModels(entry.models, allowedIds, entry.lastModified ?? 0);
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
		async initialize(supportedModels) {
			const advertisedIds = advertisedModelIds(supportedModels);
			const allowedIds = allowedModelIds(supportedModels);
			applyModels(dependencies.builtinModels, allowedIds, dependencies.builtinGeneratedAt ?? 0);
			let cacheUsable = true;
			try {
				const shared = parseStoreEntry(await dependencies.readSharedCatalog());
				applyStoredEntry(shared, allowedIds);
			} catch {
				cacheUsable = false;
			}
			const knownIds = new Set(models.map((model) => model.id));
			const missingAdvertisedModel = [...advertisedIds].some((id) => isStableClaudeModelId(id) && !knownIds.has(id));
			if (!cacheUsable || missingAdvertisedModel) {
				const fetched = await fetchCatalog();
				applyModels(fetched.models, allowedIds, fetched.lastModified ?? 0);
			}
		},
		async refresh(context, supportedModels) {
			const stored = parseStoreEntry(await context.store.read());
			const allowedIds = context.allowNetwork ? allowedModelIds(supportedModels) : stored && storedAllowedModelIds(stored);
			if (allowedIds) applyStoredEntry(stored, allowedIds);
			if (!context.allowNetwork || context.signal?.aborted) return;
			const lastAttemptAt = Math.max(stored?.checkedAt ?? 0, stored?.failedAt ?? 0);
			if (
				!context.force &&
				stored?.lastModified !== undefined &&
				dependencies.now() - lastAttemptAt < REFRESH_INTERVAL_MS
			) return;

			try {
				const canonicalEntry = await fetchCatalog(context.signal);
				if (context.signal?.aborted) return;
				const supportedModelIds = [...advertisedModelIds(supportedModels)].filter(isStableClaudeModelId);
				const entry: StoredCatalog = { ...canonicalEntry, supportedModelIds };
				applyModels(entry.models, allowedModelIds(supportedModels), entry.lastModified ?? 0);
				await context.store.write(entry as ModelsStoreEntry);
			} catch (error) {
				if (!context.signal?.aborted) {
					await context.store.write({ ...(stored ?? { models: [] }), failedAt: dependencies.now() } as ModelsStoreEntry);
				}
				throw error;
			}
		},
	};
}
