// Shared Agent SDK result helpers used by both the provider stream and
// compaction siblings: parse in-band result errors and log the served model's
// context window. Kept as free functions so neither sibling imports the other.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "@earendil-works/pi-ai";

/** The failure as the result message stated it, or null when it stated none. Naming the subtype
 *  in its place is left to the caller, which is the only one that knows what it was asking for. */
export function resultErrorText(message: SDKMessage): string | null {
	const result = message as SDKMessage & { errors?: unknown; error?: unknown };
	if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return null;
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
export function logServedContextWindow(debug: (...args: unknown[]) => void, label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}
