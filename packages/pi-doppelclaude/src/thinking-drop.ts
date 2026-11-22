import type { BetaInputTransformation } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AssistantMessage, AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import type {
  CustomEntry,
  EntryRenderOptions,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { PROVIDER_ID } from "./models.js";

export const THINKING_DROP_CUSTOM_TYPE = "pi-doppelclaude.thinking_dropped";

// The diagnostic pi's own Anthropic adapter writes, so pi's session view and its own notice read
// ours the same way.
const DIAGNOSTIC_TYPE = "anthropic_input_transformations";

export interface ThinkingDropEntryData {
  count: number;
  /** The API's reasons, verbatim; empty when it stated none. */
  reasons: string[];
}

export function inputTransformationsDiagnostic(
  transformations: BetaInputTransformation[],
): AssistantMessageDiagnostic {
  return {
    type: DIAGNOSTIC_TYPE,
    timestamp: Date.now(),
    details: {
      transformations: transformations.map(({ type, path, reason }) => ({ type, path, reason })),
    },
  };
}

function droppedThinking(message: AssistantMessage): ThinkingDropEntryData | undefined {
  const diagnostic = message.diagnostics?.find((d) => d.type === DIAGNOSTIC_TYPE);
  // Session data: details are untyped JSON written by an earlier run.
  const transformations = diagnostic?.details?.transformations;
  if (!Array.isArray(transformations)) return undefined;
  const dropped = transformations.filter(
    (t) =>
      typeof t === "object" && t !== null && !Array.isArray(t) && t.type === "thinking_dropped",
  ) as Array<{ reason?: unknown }>;
  if (!dropped.length) return undefined;
  const reasons = new Set<string>();
  for (const { reason } of dropped) if (typeof reason === "string") reasons.add(reason);
  return { count: dropped.length, reasons: [...reasons] };
}

/**
 * What to tell the user about thinking the API dropped from the request behind the assistant
 * message `messageEntryId`, or nothing. The API reports a dropped block again on every later
 * request that replays it, so only a count above the previous reply's is news.
 *
 * pi has its own notice for this diagnostic behind `showCacheMissNotices`, off by default. Once
 * the user has set it either way pi's answer stands; until then doppelclaude tells them itself.
 */
export function thinkingDropNotice(
  branch: SessionEntry[],
  messageEntryId: string,
  showCacheMissNotices: boolean | undefined,
): ThinkingDropEntryData | undefined {
  if (showCacheMissNotices !== undefined) return undefined;
  const index = branch.findIndex((entry) => entry.id === messageEntryId);
  const entry = branch[index];
  if (entry?.type !== "message" || entry.message.role !== "assistant") return undefined;
  if (entry.message.provider !== PROVIDER_ID) return undefined;
  const dropped = droppedThinking(entry.message);
  if (!dropped) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const earlier = branch[i];
    if (earlier.type === "message" && earlier.message.role === "assistant") {
      const previous = droppedThinking(earlier.message);
      return previous && dropped.count <= previous.count ? undefined : dropped;
    }
  }
  return dropped;
}

export function renderThinkingDropEntry(
  entry: CustomEntry<ThinkingDropEntryData>,
  options: EntryRenderOptions & { outputPad: number },
  theme: Theme,
): Component | undefined {
  const data = entry.data;
  if (!data) return undefined;
  const blocks =
    data.count === 1 ? "1 earlier thinking block" : `${data.count} earlier thinking blocks`;
  const reasons = data.reasons.length ? ` (${data.reasons.join(", ")})` : "";
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      theme.fg("warning", `⚠ Claude's API dropped ${blocks} before this reply${reasons}`),
      0,
      0,
    ),
  );
  return box;
}
