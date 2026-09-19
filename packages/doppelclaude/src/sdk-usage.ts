import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

export interface SdkUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  reasoning_tokens?: number | null;
  thinking_tokens?: number | null;
}

export type SdkModelUsage = Record<string, ModelUsage>;

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
