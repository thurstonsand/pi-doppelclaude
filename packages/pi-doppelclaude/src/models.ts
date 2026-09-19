import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "doppelclaude";
export const PROVIDER_NAME = "Doppelclaude";
export const PROVIDER_API = "doppelclaude";
export const PROVIDER_BASE_URL = "claude-code://local";

// The marker survives modelOverrides but cannot be supplied by models.json, so user-defined
// replacements never cross the provider boundary as catalog-confirmed models. Symbol.for, not
// Symbol: /reload re-evaluates the module graph, and models projected by the previous generation
// must still pass the new generation's check.
const BRIDGE_MODEL = Symbol.for("pi-doppelclaude.model");
const MODEL_FAMILIES_IN_ORDER = ["fable", "opus", "sonnet", "haiku"];
const NUMERIC_MODEL_VERSION = /^\d+$/u;
const SHORT_MODEL_VERSION_PART = /^\d{1,2}$/u;
const TWO_HUNDRED_K_CONTEXT = 200_000;
// Every model Claude Code currently serves is offered at 1M through the `[1m]` form, so a model
// nobody can describe yet is assumed to be one more of them.
const SYNTHESIZED_CONTEXT_WINDOW = 1_000_000;
const SYNTHESIZED_MAX_TOKENS = 64_000;

export interface BridgeModel extends Model<typeof PROVIDER_API> {
  readonly [BRIDGE_MODEL]: string;
}

/** The part of Claude Code's `ModelInfo` that describes a model rather than names one. */
export interface AdvertisedModel {
  displayName: string;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
}

function advertisedThinkingLevels(advertised: AdvertisedModel): ThinkingLevelMap | undefined {
  if (!advertised.supportedEffortLevels && !advertised.supportsAdaptiveThinking) return undefined;
  const map: ThinkingLevelMap = {};
  // Pi hides a level absent from an explicit map, and adaptive thinking is Claude deciding for
  // itself, which is exactly the model that cannot be told to stop.
  if (advertised.supportsAdaptiveThinking) map.off = null;
  for (const level of advertised.supportedEffortLevels ?? []) map[level] = level;
  return map;
}

// Claude Code serves a model the moment Anthropic ships it; Pi's catalog describes it a day or two
// later. Until then the model is offered on what Claude Code itself said plus floors: zero cost,
// because the SDK's own `costUSD` is what the turn total is built from, and a window the whole
// current lineup honors. The described entry supersedes this one as soon as it arrives.
export function synthesizeModel(id: string, advertised: AdvertisedModel): BridgeModel {
  const thinkingLevelMap = advertisedThinkingLevels(advertised);
  return {
    id,
    name: advertised.displayName,
    api: PROVIDER_API,
    provider: PROVIDER_ID,
    baseUrl: PROVIDER_BASE_URL,
    reasoning: true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: SYNTHESIZED_CONTEXT_WINDOW,
    maxTokens: SYNTHESIZED_MAX_TOKENS,
    [BRIDGE_MODEL]: id,
  };
}

export function isSupportedModel(model: Model<Api>): model is BridgeModel {
  return (
    (model as Partial<BridgeModel>)[BRIDGE_MODEL] === model.id &&
    model.provider === PROVIDER_ID &&
    model.api === PROVIDER_API &&
    model.baseUrl === PROVIDER_BASE_URL
  );
}

export function unsupportedModelMessage(model: {
  id: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
}): string {
  if (model.provider === undefined) return `Unsupported Doppelclaude model: ${model.id}`;
  return `Unsupported Doppelclaude model: ${model.provider}/${model.id} (api=${model.api}, baseUrl=${model.baseUrl})`;
}

function modelOrder(id: string): [number, number[]] | undefined {
  const [prefix, family, firstVersion, ...remainingVersion] = id.split("-");
  const familyIndex = MODEL_FAMILIES_IN_ORDER.indexOf(family);
  if (
    prefix !== "claude" ||
    familyIndex < 0 ||
    !NUMERIC_MODEL_VERSION.test(firstVersion ?? "") ||
    !remainingVersion.every((part) => SHORT_MODEL_VERSION_PART.test(part))
  )
    return undefined;
  return [familyIndex, [firstVersion, ...remainingVersion].map(Number)];
}

export function isStableClaudeModelId(id: string): boolean {
  return modelOrder(id) !== undefined;
}

function projectModel(canonical: Model<Api>): BridgeModel {
  const { compat: _canonicalApiCompatibility, ...metadata } = canonical;
  return {
    ...metadata,
    api: PROVIDER_API,
    provider: PROVIDER_ID,
    baseUrl: PROVIDER_BASE_URL,
    [BRIDGE_MODEL]: canonical.id,
  };
}

export function compareModels(left: Model<Api>, right: Model<Api>): number {
  const [leftFamily, leftVersion] = modelOrder(left.id) ?? [Number.MAX_SAFE_INTEGER, []];
  const [rightFamily, rightVersion] = modelOrder(right.id) ?? [Number.MAX_SAFE_INTEGER, []];
  if (leftFamily !== rightFamily) return leftFamily - rightFamily;
  for (let index = 0; index < Math.max(leftVersion.length, rightVersion.length); index++) {
    const difference = (rightVersion[index] ?? -1) - (leftVersion[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return left.id.localeCompare(right.id);
}

export function projectCatalogModels(
  canonicalModels: readonly Model<Api>[],
  allowedIds: ReadonlySet<string>,
): BridgeModel[] {
  return canonicalModels
    .filter((model) => allowedIds.has(model.id) && isStableClaudeModelId(model.id))
    .map(projectModel);
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
  return (
    (model?.thinkingLevelMap?.[reasoning] as EffortLevel | undefined) ??
    REASONING_TO_EFFORT[reasoning]
  );
}

export function claudeCodeModelId(model: Model<Api>): string {
  if (!isSupportedModel(model)) throw new Error(unsupportedModelMessage(model));
  return model.contextWindow > TWO_HUNDRED_K_CONTEXT ? `${model.id}[1m]` : model.id;
}
