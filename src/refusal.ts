import type {
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CustomEntry, EntryRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { canonicalClaudeModelId } from "./models.js";

export const REFUSAL_CUSTOM_TYPE = "pi-claude-bridge.model_refusal";

export interface RefusalEntryData {
  requestedModel: string;
  /** The model the retry ran on, or null when Claude declined without rerouting. */
  servedModel: string | null;
  /** Open string (`cyber`, `bio`, …); null on the server lane and on older CLIs. */
  category: string | null;
  /** Claude's own prose about the refusal. Absent on the server lane. */
  explanation: string | null;
  /** The banner Claude Code renders for this event. Always empty for a refusal with no fallback. */
  claudeMessage: string;
  requestId: string | null;
}

export function refusalEntryData(
  message: SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage,
): RefusalEntryData {
  return {
    requestedModel: canonicalClaudeModelId(message.original_model),
    servedModel:
      message.subtype === "model_refusal_fallback"
        ? canonicalClaudeModelId(message.fallback_model)
        : null,
    category: message.api_refusal_category ?? null,
    explanation: message.api_refusal_explanation ?? null,
    claudeMessage: message.content,
    requestId: message.request_id,
  };
}

function headline(data: RefusalEntryData): string {
  const category = data.category ? ` (${data.category})` : "";
  return data.servedModel
    ? `${data.requestedModel} refused${category} — rerouted to ${data.servedModel} for the rest of this conversation`
    : `${data.requestedModel} refused${category} — no reply was generated`;
}

export function renderRefusalEntry(
  entry: CustomEntry<RefusalEntryData>,
  options: EntryRenderOptions,
  theme: Theme,
): Component | undefined {
  const data = entry.data;
  if (!data) return undefined;

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const line = (text: string) => box.addChild(new Text(text, 0, 0));

  if (!options.expanded) {
    const key = keyText("app.tools.expand");
    line(
      key
        ? theme.fg("warning", `⚠ ${headline(data)} (`) +
            theme.fg("dim", key) +
            theme.fg("warning", " to expand)")
        : theme.fg("warning", `⚠ ${headline(data)} (expand key unbound)`),
    );
    return box;
  }

  line(theme.fg("warning", `⚠ ${headline(data)}`));
  if (data.explanation) line(theme.fg("customMessageText", data.explanation));
  // Claude Code's own banner, kept verbatim but subordinated: it names models by display
  // name and offers Claude Code slash commands that do not exist here.
  if (data.claudeMessage) line(theme.fg("dim", data.claudeMessage));
  if (data.requestId) line(theme.fg("dim", `request ${data.requestId}`));
  return box;
}
