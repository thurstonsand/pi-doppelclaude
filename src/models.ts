import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model } from "@earendil-works/pi-ai";

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
const LONG_CONTEXT_FORM = /\[1m\]$/u;
const DATED_SNAPSHOT = /-\d{8}$/u;
const TWO_HUNDRED_K_CONTEXT = 200_000;

export interface BridgeModel extends Model<typeof PROVIDER_API> {
  readonly [BRIDGE_MODEL]: string;
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

// Claude names a model by whichever form the caller met it in: a long-context form
// (`claude-opus-5[1m]`) or a dated snapshot (`claude-haiku-4-5-20251001`). Pi names the
// family, and Claude serves it, so both forms normalize onto the family ID.
export function canonicalClaudeModelId(advertised: string): string {
  return advertised.replace(LONG_CONTEXT_FORM, "").replace(DATED_SNAPSHOT, "");
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
