import { calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryContext } from "./query-state.js";
import { mapSdkToolArgsToPi, mapSdkToolNameToPi } from "./convert.js";

interface ProviderStreamDependencies {
	debug(...args: unknown[]): void;
	notify?(message: string, level: "warning"): void;
}

export function resultErrorText(message: SDKMessage): string {
	const result = message as SDKMessage & { subtype?: string; errors?: unknown; error?: unknown };
	if (Array.isArray(result.errors) && result.errors.length > 0) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

export function createProviderStreamRuntime(dependencies: ProviderStreamDependencies) {
	const { debug, notify } = dependencies;

	// --- Usage helpers ---

	function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
		if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
		if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
		if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
		if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
		// Claude Code may report reasoning/thinking tokens separately, while pi's Usage type does not model that field.
		const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
		if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
		output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		calculateCost(model, output.usage);
		const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
		const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
		const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
		debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
	}

	// Log the *served* context window reported by an SDK result message
	// (modelUsage[id].contextWindow), which can differ from the window pi
	// registered (model.contextWindow) when the runtime entitlement doesn't
	// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
	// The result message's modelUsage is otherwise discarded; this makes the
	// gap observable. See issue #18.
	function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
		const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
		if (!modelUsage) return;
		for (const [k, v] of Object.entries(modelUsage)) {
			debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
		}
	}

	// --- Provider helpers: misc ---

	function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
		switch (reason) {
			case "tool_use": return "toolUse";
			case "max_tokens": return "length";
			case "end_turn": default: return "stop";
		}
	}

	function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
		if (!input) return fallback;
		try { return JSON.parse(input); } catch { return fallback; }
	}


	// --- Provider: streaming function ---
	//
	// Push-based streaming with MCP tool bridge:
	// 1. streamSimple starts a query() and kicks off consumeQuery() in background
	// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
	// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
	//    blocks the generator naturally — no events arrive until resolved.
	// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
	//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
	//
	// Note: resetTurnState clears turnSawStreamEvent while the generator may still
	// have queued messages from the previous turn. This is safe because step 3 nulls
	// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
	// in consumeQuery and are skipped before resetTurnState runs.

	const completedStreams = new WeakSet<object>();

	function markStreamComplete(stream: AssistantMessageEventStream | null): void {
		if (stream) completedStreams.add(stream as object);
	}

	function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
		if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
			debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
		}
		c.currentPiStream = stream;
	}

	function ensureTurnStarted(c: QueryContext): void {
		if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
			c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
			c.turnStarted = true;
		}
	}

	function emitTerminalError(c: QueryContext, reason: "aborted" | "error", message: string): void {
		if (!c.turnOutput) return;
		c.turnOutput.stopReason = reason;
		c.turnOutput.errorMessage = message;
		if (!c.currentPiStream) return;
		ensureTurnStarted(c);
		const stream = c.currentPiStream;
		stream.push({ type: "error", reason, error: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}

	function finalizeCurrentStream(c: QueryContext): void {
		if (!c.currentPiStream || !c.turnOutput) return;
		debug(`provider: finalizeCurrentStream called, turnOutput=${JSON.stringify({stopReason: c.turnOutput.stopReason, error: c.turnOutput.errorMessage})}`);
		if (c.turnOutput.stopReason === "error") {
			emitTerminalError(c, "error", c.turnOutput.errorMessage ?? "Query failed");
			return;
		}
		if (!c.turnStarted) ensureTurnStarted(c);
		const stream = c.currentPiStream;
		const reason = c.turnOutput.stopReason === "length" ? "length" : "stop";
		stream.push({ type: "done", reason, message: c.turnOutput });
		markStreamComplete(stream);
		stream.end();
		c.currentPiStream = null;
	}

	/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
	 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
	function processStreamEvent(
		message: SDKMessage,
		customToolNameToPi: Map<string, string>,
		model: Model<any>,
		c: QueryContext,
	): void {
		if (!c.currentPiStream || !c.turnOutput) return;
		c.turnSawStreamEvent = true;
		const event = (message as SDKMessage & { event: any }).event;

		if (event?.type === "message_start") {
			c.turnToolCallIds = [];
			if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
			return;
		}

		if (event?.type === "content_block_start") {
			ensureTurnStarted(c);
			if (event.content_block?.type === "text") {
				c.turnBlocks.push({ type: "text", text: "", index: event.index });
				c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
			} else if (event.content_block?.type === "thinking") {
				c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
				c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
			} else if (event.content_block?.type === "tool_use") {
				c.turnSawToolCall = true;
				c.turnToolCallIds.push(event.content_block.id);
				c.turnBlocks.push({
					type: "toolCall", id: event.content_block.id,
					name: mapSdkToolNameToPi(event.content_block.name, customToolNameToPi),
					arguments: (event.content_block.input as Record<string, unknown>) ?? {},
					partialJson: "", index: event.index,
				});
				c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
			} else {
				debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
			}
			return;
		}

		if (event?.type === "content_block_delta") {
			const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
			const block = c.turnBlocks[index];
			if (!block) return;
			if (event.delta?.type === "text_delta" && block.type === "text") {
				block.text += event.delta.text;
				c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
			} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
				block.thinking += event.delta.thinking;
				c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
			} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
				block.partialJson += event.delta.partial_json;
				block.arguments = parsePartialJson(block.partialJson, block.arguments);
				c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
			} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
				block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
			} else {
				debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
			}
			return;
		}

		if (event?.type === "content_block_stop") {
			const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
			const block = c.turnBlocks[index];
			if (!block) return;
			delete block.index;
			if (block.type === "text") {
				c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
			} else if (block.type === "thinking") {
				c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
			} else if (block.type === "toolCall") {
				c.turnSawToolCall = true;
				block.arguments = mapSdkToolArgsToPi(
					block.name, parsePartialJson(block.partialJson, block.arguments),
				);
				delete block.partialJson;
				c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
			}
			return;
		}

		if (event?.type === "message_delta") {
			c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
			if (event.usage) updateUsage(c.turnOutput, event.usage, model);
			return;
		}

		if (event?.type === "message_stop" && c.turnSawToolCall) {
			// Tool call complete — end this pi stream. The SDK will still yield an
			// assistant message for this turn, but currentPiStream=null causes
			// consumeQuery to skip it. The MCP handler blocks the generator until
			// pi delivers the tool result via the next streamSimple call.
			c.turnOutput.stopReason = "toolUse";
			const stream = c.currentPiStream;
			stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
			markStreamComplete(stream);
			stream!.end();
			c.currentPiStream = null;

			// Cursor is updated by the next streamSimple call (tool result delivery path)
			// which sets cursor = context.messages.length with the post-tool-result context.
			return;
		}

		if (event?.type !== "message_stop" && event?.type !== "ping") {
			debug("processStreamEvent: unhandled event type", event?.type);
		}
	}

	// The SDK always yields `assistant` messages (completed content blocks) after streaming.
	// When stream_events already delivered the content, this is a no-op. But after
	// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
	// arrives before any stream_events, this is the primary content path. Must maintain
	// the same stream lifecycle as processStreamEvent — including ending the stream on
	// tool_use to prevent deadlock with the MCP handler.
	function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
		if (c.turnSawStreamEvent) return;
		const assistantMsg = (message as any).message;
		if (!assistantMsg?.content) return;
		c.turnToolCallIds = [];
		debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) {
				ensureTurnStarted(c);
				c.turnBlocks.push({ type: "text", text: block.text });
				const idx = c.turnBlocks.length - 1;
				c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
			} else if (block.type === "thinking") {
				ensureTurnStarted(c);
				c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
				const idx = c.turnBlocks.length - 1;
				c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
				if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
			} else if (block.type === "tool_use") {
				ensureTurnStarted(c);
				c.turnSawToolCall = true;
				c.turnToolCallIds.push(block.id);
				const mappedArgs = mapSdkToolArgsToPi(mapSdkToolNameToPi(block.name, customToolNameToPi), block.input);
				c.turnBlocks.push({
					type: "toolCall", id: block.id,
					name: mapSdkToolNameToPi(block.name, customToolNameToPi),
					arguments: mappedArgs,
				});
				const idx = c.turnBlocks.length - 1;
				const toolBlock = c.turnBlocks[idx];
				c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
				c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
			} else {
				debug("processAssistantMessage: unhandled block type", block.type);
			}
		}
		if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

		// End the stream on tool_use, same as processStreamEvent's message_stop handler.
		if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
			c.turnOutput.stopReason = "toolUse";
			const stream = c.currentPiStream;
			stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
			c.currentPiStream = null;
		}
	}

	/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
	 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
	 *  an assistant message (completed blocks). On tool_use, the stream is ended by
	 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
	 *  and the MCP handler blocks the generator until pi delivers the tool result. */
	interface QueryConsumerHooks {
		onResult(message: SDKMessage): void;
		onSessionId(sessionId: string): void;
	}

	async function consumeQuery(
		sdkQuery: ReturnType<typeof query>,
		customToolNameToPi: Map<string, string>,
		model: Model<any>,
		queryCtx: QueryContext,
		hooks: QueryConsumerHooks,
	): Promise<void> {
		let capturedSessionId: string | undefined;

		for await (const message of sdkQuery) {
			if (message.type === "system" && (message as any).subtype === "init" && (message as any).session_id) {
				capturedSessionId = (message as any).session_id;
				hooks.onSessionId(capturedSessionId!);
			}
			if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

			const currentModel = queryCtx.activeModel ?? model;
			switch (message.type) {
				case "stream_event":
					processStreamEvent(message, customToolNameToPi, currentModel, queryCtx);
					break;
				case "assistant":
					processAssistantMessage(message, currentModel, customToolNameToPi, queryCtx);
					break;
				case "result":
					logServedContextWindow("result", message, currentModel);
					if (message.subtype !== "success") {
						queryCtx.turnOutput.stopReason = "error";
						queryCtx.turnOutput.errorMessage = resultErrorText(message);
					} else if (!queryCtx.turnSawStreamEvent) {
						ensureTurnStarted(queryCtx);
						const text = message.result || "";
						queryCtx.turnBlocks.push({ type: "text", text });
						const idx = queryCtx.turnBlocks.length - 1;
						queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
						queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
						queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
					}
					hooks.onResult(message);
					break;
				case "system":
					break;
				case "user":
					break; // SDK echo of user prompt — not needed
				case "rate_limit_event": {
					const info = (message as any).rate_limit_info;
					debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
					if (info?.status === "rejected") {
						const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
						notify?.(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
					} else if (info?.status === "allowed_warning") {
						notify?.(`Claude rate limit warning: ${Math.round(info.utilization ?? 0)}% used (${info.rateLimitType ?? ""})`, "warning");
					}
					break;
				}
				default:
					debug("consumeQuery: unhandled SDK message type", message.type);
					break;
			}
		}

		debug(`consumeQuery: for-await loop exited, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);
	}


	return {
		claimCurrentPiStream,
		emitTerminalError,
		finalizeCurrentStream,
		consumeQuery,
		logServedContextWindow,
	};
}
