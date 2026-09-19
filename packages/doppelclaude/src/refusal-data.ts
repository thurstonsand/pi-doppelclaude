import type {
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { canonicalClaudeModelId } from "./model-id.js";

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
