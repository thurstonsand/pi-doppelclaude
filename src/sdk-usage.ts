import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import {
  type Api,
  type AssistantMessage,
  calculateCost,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { isSyntheticModelId } from "./sdk-signals.js";

export interface SdkUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  reasoning_tokens?: number | null;
  thinking_tokens?: number | null;
}

export type SdkModelUsage = Record<string, ModelUsage>;

const canonicalModels = new Map(getBuiltinModels("anthropic").map((model) => [model.id, model]));

export function applySdkUsage(output: AssistantMessage, usage: SdkUsage, model: Model<Api>): void {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null)
    output.usage.cacheWrite = usage.cache_creation_input_tokens;
  const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
  if (reasoning != null) output.usage.reasoning = reasoning;
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
}

function nonnegativeDelta(current: number, previous: number | undefined): number {
  // A lower counter means the SDK started a fresh accounting epoch; use its new total as this turn's delta.
  if (previous === undefined || current < previous) return current;
  return current - previous;
}

export function diffSdkModelUsage(current: SdkModelUsage, previous: SdkModelUsage): SdkModelUsage {
  return Object.fromEntries(
    Object.entries(current).flatMap(([key, usage]) => {
      const prior = previous[key];
      const delta: ModelUsage = {
        inputTokens: nonnegativeDelta(usage.inputTokens, prior?.inputTokens),
        outputTokens: nonnegativeDelta(usage.outputTokens, prior?.outputTokens),
        cacheReadInputTokens: nonnegativeDelta(
          usage.cacheReadInputTokens,
          prior?.cacheReadInputTokens,
        ),
        cacheCreationInputTokens: nonnegativeDelta(
          usage.cacheCreationInputTokens,
          prior?.cacheCreationInputTokens,
        ),
        webSearchRequests: nonnegativeDelta(usage.webSearchRequests, prior?.webSearchRequests),
        costUSD: nonnegativeDelta(usage.costUSD, prior?.costUSD),
        contextWindow: usage.contextWindow,
        maxOutputTokens: usage.maxOutputTokens,
        canonicalModel: usage.canonicalModel,
        provider: usage.provider,
      };
      const hasUsage =
        delta.inputTokens > 0 ||
        delta.outputTokens > 0 ||
        delta.cacheReadInputTokens > 0 ||
        delta.cacheCreationInputTokens > 0 ||
        delta.webSearchRequests > 0 ||
        delta.costUSD > 0;
      return hasUsage ? [[key, delta]] : [];
    }),
  ) as SdkModelUsage;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export interface ModelUsageAccounting {
  usage: Usage;
  servedModels: string[];
  fallbackModels: string[];
  unknownModels: string[];
  costUSD: number;
}

export function accountSdkModelUsage(
  modelUsage: SdkModelUsage,
  requestedModel: Model<Api>,
): ModelUsageAccounting {
  const aggregate = emptyUsage();
  const servedModels = new Set<string>();
  const unknownModels = new Set<string>();
  let costUSD = 0;

  for (const [rawModel, usage] of Object.entries(modelUsage)) {
    const servedModel = usage.canonicalModel ?? rawModel;
    // Nothing served a fabricated message; its tokens are not the account of a turn.
    if (isSyntheticModelId(servedModel)) continue;
    servedModels.add(servedModel);
    aggregate.input += usage.inputTokens;
    aggregate.output += usage.outputTokens;
    aggregate.cacheRead += usage.cacheReadInputTokens;
    aggregate.cacheWrite += usage.cacheCreationInputTokens;
    costUSD += usage.costUSD;

    const pricingModel = canonicalModels.get(servedModel);
    if (!pricingModel) {
      unknownModels.add(servedModel);
      continue;
    }
    const priced = emptyUsage();
    priced.input = usage.inputTokens;
    priced.output = usage.outputTokens;
    priced.cacheRead = usage.cacheReadInputTokens;
    priced.cacheWrite = usage.cacheCreationInputTokens;
    priced.totalTokens = priced.input + priced.output + priced.cacheRead + priced.cacheWrite;
    calculateCost(pricingModel, priced);
    aggregate.cost.input += priced.cost.input;
    aggregate.cost.output += priced.cost.output;
    aggregate.cost.cacheRead += priced.cost.cacheRead;
    aggregate.cost.cacheWrite += priced.cost.cacheWrite;
  }

  aggregate.totalTokens =
    aggregate.input + aggregate.output + aggregate.cacheRead + aggregate.cacheWrite;
  aggregate.cost.total = costUSD;
  const served = [...servedModels];
  return {
    usage: aggregate,
    servedModels: served,
    fallbackModels: served.filter((model) => model !== requestedModel.id),
    unknownModels: [...unknownModels],
    costUSD,
  };
}

export function reconcileSdkModelUsage(
  outputs: AssistantMessage[],
  modelUsage: SdkModelUsage,
  requestedModel: Model<Api>,
): ModelUsageAccounting {
  const accounting = accountSdkModelUsage(modelUsage, requestedModel);
  const lastOutput = outputs.at(-1);
  if (!lastOutput) return accounting;
  const servedModel =
    accounting.servedModels.length === 1
      ? canonicalModels.get(accounting.servedModels[0])
      : undefined;
  if (servedModel) {
    for (const output of outputs) calculateCost(servedModel, output.usage);
  }
  const reportedCost = outputs.reduce((total, output) => total + output.usage.cost.total, 0);
  lastOutput.usage.cost.total += accounting.costUSD - reportedCost;
  return accounting;
}

export function debugSdkUsage(
  debug: (...args: unknown[]) => void,
  output: AssistantMessage,
  model: Model<Api>,
): void {
  const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
  const cachePct = promptTokens > 0 ? Math.round((output.usage.cacheRead / promptTokens) * 100) : 0;
  const reasoningText =
    output.usage.reasoning != null ? ` reasoning=${output.usage.reasoning}` : "";
  debug(
    `usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`,
  );
}
