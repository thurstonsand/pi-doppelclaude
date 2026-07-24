import type { Model } from "@earendil-works/pi-ai";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const PROVIDER_ID = "anthropic-agent-sdk";
export const PROVIDER_NAME = "Anthropic Agent SDK";
export const PROVIDER_API = "anthropic-agent-sdk";
export const PROVIDER_BASE_URL = "claude-code://local";

export const MODEL_IDS_IN_ORDER = ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5"] as const;

export type SupportedModelId = typeof MODEL_IDS_IN_ORDER[number];
export type BridgeModel = Model<typeof PROVIDER_API>;

const SUPPORTED_MODEL_IDS = new Set<string>(MODEL_IDS_IN_ORDER);
const BARE_ONE_M_MODEL_IDS = new Set<string>(["claude-opus-4-7"]);
const TWO_HUNDRED_K_CONTEXT = 200_000;

export function isSupportedModelId(id: string): id is SupportedModelId {
	return SUPPORTED_MODEL_IDS.has(id);
}

export function isSupportedModel(model: Model<any>): model is BridgeModel {
	return isSupportedModelId(model.id) &&
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

export function buildModels(canonicalModels: readonly Model<any>[]): BridgeModel[] {
	return MODEL_IDS_IN_ORDER.map((id) => {
		const canonical = canonicalModels.find((model) => model.id === id);
		if (!canonical) throw new Error(`Pi's Anthropic catalog is missing required model ${id}`);
		return {
			id: canonical.id,
			name: canonical.name,
			api: PROVIDER_API,
			provider: PROVIDER_ID,
			baseUrl: PROVIDER_BASE_URL,
			reasoning: canonical.reasoning,
			thinkingLevelMap: canonical.thinkingLevelMap,
			input: canonical.input,
			cost: canonical.cost,
			contextWindow: canonical.contextWindow,
			maxTokens: canonical.maxTokens,
			headers: canonical.headers,
		};
	});
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

export function claudeCodeModelId(model: { id: string; contextWindow: number }): string {
	if (!isSupportedModelId(model.id)) throw new Error(unsupportedModelMessage(model));
	if (model.contextWindow > TWO_HUNDRED_K_CONTEXT && !BARE_ONE_M_MODEL_IDS.has(model.id)) {
		return `${model.id}[1m]`;
	}
	return model.id;
}
