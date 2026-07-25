import type { Model } from "@earendil-works/pi-ai";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const PROVIDER_ID = "anthropic-agent-sdk";
export const PROVIDER_NAME = "Anthropic Agent SDK";
export const PROVIDER_API = "anthropic-agent-sdk";
export const PROVIDER_BASE_URL = "claude-code://local";

export const MODEL_IDS_IN_ORDER = ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"] as const;

// The marker survives modelOverrides but cannot be supplied by models.json, so user-defined
// replacements never cross the provider boundary as catalog-confirmed models.
const BRIDGE_MODEL = Symbol("pi-claude-bridge.model");
const MODEL_FAMILIES_IN_ORDER = ["fable", "opus", "sonnet", "haiku"];
const NUMERIC_MODEL_VERSION = /^\d+$/u;
const SHORT_MODEL_VERSION_PART = /^\d{1,2}$/u;
const BARE_ONE_M_MODEL_IDS = new Set<string>(["claude-opus-4-7"]);
const TWO_HUNDRED_K_CONTEXT = 200_000;

export interface BridgeModel extends Model<typeof PROVIDER_API> {
	readonly [BRIDGE_MODEL]: string;
}

export function isSupportedModel(model: Model<any>): model is BridgeModel {
	return (model as Partial<BridgeModel>)[BRIDGE_MODEL] === model.id &&
		model.provider === PROVIDER_ID &&
		model.api === PROVIDER_API &&
		model.baseUrl === PROVIDER_BASE_URL;
}

export function unsupportedModelMessage(model: {
	id: string;
	provider?: string;
	api?: string;
	baseUrl?: string;
}): string {
	if (model.provider === undefined) return `Unsupported Anthropic Agent SDK model: ${model.id}`;
	return `Unsupported Anthropic Agent SDK model: ${model.provider}/${model.id} (api=${model.api}, baseUrl=${model.baseUrl})`;
}

function modelOrder(id: string): [number, number[]] | undefined {
	const [prefix, family, firstVersion, ...remainingVersion] = id.split("-");
	const familyIndex = MODEL_FAMILIES_IN_ORDER.indexOf(family);
	if (
		prefix !== "claude" ||
		familyIndex < 0 ||
		!NUMERIC_MODEL_VERSION.test(firstVersion ?? "") ||
		!remainingVersion.every((part) => SHORT_MODEL_VERSION_PART.test(part))
	) return undefined;
	return [familyIndex, [firstVersion, ...remainingVersion].map(Number)];
}

export function isStableClaudeModelId(id: string): boolean {
	return modelOrder(id) !== undefined;
}

function projectModel(canonical: Model<any>): BridgeModel {
	const { compat: _canonicalApiCompatibility, ...metadata } = canonical;
	return {
		...metadata,
		api: PROVIDER_API,
		provider: PROVIDER_ID,
		baseUrl: PROVIDER_BASE_URL,
		[BRIDGE_MODEL]: canonical.id,
	};
}

export function compareModels(left: Model<any>, right: Model<any>): number {
	const [leftFamily, leftVersion] = modelOrder(left.id) ?? [Number.MAX_SAFE_INTEGER, []];
	const [rightFamily, rightVersion] = modelOrder(right.id) ?? [Number.MAX_SAFE_INTEGER, []];
	if (leftFamily !== rightFamily) return leftFamily - rightFamily;
	for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index++) {
		const difference = (rightVersion[index] ?? -1) - (leftVersion[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return left.id.localeCompare(right.id);
}

export function projectCatalogModels(canonicalModels: readonly Model<any>[], allowedIds: ReadonlySet<string>): BridgeModel[] {
	return canonicalModels
		.filter((model) => allowedIds.has(model.id) && isStableClaudeModelId(model.id))
		.map(projectModel)
		.sort(compareModels);
}

export function buildModels(canonicalModels: readonly Model<any>[]): BridgeModel[] {
	for (const id of MODEL_IDS_IN_ORDER) {
		if (!canonicalModels.some((model) => model.id === id)) {
			throw new Error(`Pi's Anthropic catalog is missing required model ${id}`);
		}
	}
	return MODEL_IDS_IN_ORDER.map((id) => projectModel(canonicalModels.find((model) => model.id === id)!));
}

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
};

export function resolveThinkingEffort(
	model: { thinkingLevelMap?: Record<string, string | null> } | undefined,
	reasoning: string | undefined,
): EffortLevel | undefined {
	if (!reasoning || reasoning === "off") return undefined;
	return (model?.thinkingLevelMap?.[reasoning] as EffortLevel | undefined) ?? REASONING_TO_EFFORT[reasoning];
}

export function claudeCodeModelId(model: Model<any>): string {
	if (!isSupportedModel(model)) throw new Error(unsupportedModelMessage(model));
	if (model.contextWindow > TWO_HUNDRED_K_CONTEXT && !BARE_ONE_M_MODEL_IDS.has(model.id)) {
		return `${model.id}[1m]`;
	}
	return model.id;
}
