import { type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { type Query, type SDKAssistantMessage, type SDKMessage, type SDKMirrorErrorMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryContext } from "./query-state.js";
import { mapSdkToolArgsToPi, mapSdkToolNameToPi } from "./convert.js";
import { logServedContextWindow, resultErrorText } from "./sdk-result.js";
import { applySdkUsage, debugSdkUsage, diffSdkModelUsage, reconcileSdkModelUsage } from "./sdk-usage.js";
import { apiStatusFailure, assistantApiFailure, classifyResult, formatRateLimitMessage } from "./sdk-signals.js";

interface ProviderStreamDependencies {
	debug(...args: unknown[]): void;
	notify?(message: string, level: "warning"): void;
}

export function createProviderStreamRuntime(dependencies: ProviderStreamDependencies) {
	const { debug, notify } = dependencies;

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
	// currentPiStream, so any leftover messages hit the `!queryCtx.currentPiStream` guard
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
			if (event.message?.usage && c.turnOutput) applySdkUsage(c.turnOutput, event.message.usage, model);
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
			if (event.usage) applySdkUsage(c.turnOutput, event.usage, model);
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
	function processAssistantMessage(message: SDKAssistantMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
		if (message.aborted) c.turnSawAbortedAssistant = true;
		c.turnApiFailure ??= assistantApiFailure(message.error);
		if (c.turnSawStreamEvent) return;
		const assistantMsg = message.message;
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
				const mappedArgs = mapSdkToolArgsToPi(mapSdkToolNameToPi(block.name, customToolNameToPi), block.input as Record<string, unknown>);
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
		if (assistantMsg.usage && c.turnOutput) applySdkUsage(c.turnOutput, assistantMsg.usage, model);

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
		onResult(message: SDKResultMessage): void;
		onSessionId(sessionId: string): void;
		onMirrorError?(message: SDKMirrorErrorMessage): void;
	}

	function processResultMessage(message: SDKResultMessage, currentModel: Model<any>, queryCtx: QueryContext): void {
		logServedContextWindow(debug, "result", message, currentModel);
		const modelUsage = diffSdkModelUsage(message.modelUsage, queryCtx.modelUsageSnapshot);
		queryCtx.modelUsageSnapshot = structuredClone(message.modelUsage);
		for (const [rawModel, usage] of Object.entries(modelUsage)) {
			debug(`usage: servedModel=${usage.canonicalModel ?? rawModel} rawModel=${rawModel} provider=${usage.provider ?? "unknown"} input=${usage.inputTokens} output=${usage.outputTokens} cacheRead=${usage.cacheReadInputTokens} cacheWrite=${usage.cacheCreationInputTokens} costUSD=${usage.costUSD}`);
		}

		const statusFailure = message.subtype === "success" ? apiStatusFailure(message.api_error_status) : null;
		const structuredFailure = queryCtx.turnRateLimitRejection ?? queryCtx.turnApiFailure ?? statusFailure;
		const detail = message.subtype !== "success" || message.is_error ? resultErrorText(message) : null;
		queryCtx.turnResultVerdict = classifyResult(message, structuredFailure, detail);
		const verdict = queryCtx.turnResultVerdict;
		if (!queryCtx.turnOutput) return;

		const accounting = reconcileSdkModelUsage(queryCtx.commandOutputs, modelUsage, currentModel);
		debugSdkUsage(debug, queryCtx.turnOutput, currentModel);
		debug(`usage: served=${accounting.servedModels.join(",") || "none"} sdkCostUSD=${accounting.costUSD}`);
		if (accounting.fallbackModels.length > 0) {
			const fallback = `Claude served ${accounting.fallbackModels.join(", ")} instead of requested ${currentModel.id}; usage priced from served model`;
			debug(`usage: fallback ${fallback}`);
			notify?.(fallback, "warning");
		}
		if (accounting.unknownModels.length > 0) {
			debug(`usage: no Pi catalog pricing for served model(s): ${accounting.unknownModels.join(", ")}; preserving SDK total cost`);
		}

		if (verdict.type !== "reusable") {
			queryCtx.turnOutput.stopReason = "error";
			queryCtx.turnOutput.errorMessage = verdict.message;
			return;
		}
		if (!queryCtx.turnSawStreamEvent) {
			ensureTurnStarted(queryCtx);
			const text = message.subtype === "success" ? message.result : "";
			queryCtx.turnBlocks.push({ type: "text", text });
			const index = queryCtx.turnBlocks.length - 1;
			queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: index, partial: queryCtx.turnOutput });
			queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: index, delta: text, partial: queryCtx.turnOutput });
			queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: index, content: text, partial: queryCtx.turnOutput });
		}
	}

	async function consumeQuery(
		sdkQuery: Query,
		customToolNameToPi: Map<string, string>,
		model: Model<any>,
		queryCtx: QueryContext,
		hooks: QueryConsumerHooks,
	): Promise<void> {
		let capturedSessionId: string | undefined;

		for await (const message of sdkQuery) {
			const currentModel = queryCtx.activeModel ?? model;
			switch (message.type) {
				case "system":
					switch (message.subtype) {
						case "init":
							capturedSessionId = message.session_id;
							hooks.onSessionId(capturedSessionId);
							break;
						case "mirror_error":
							debug("consumeQuery: sessionStore mirror_error", message.error, message.key);
							hooks.onMirrorError?.(message);
							break;
						case "api_retry": {
							const failure = apiStatusFailure(message.error_status) ?? assistantApiFailure(message.error);
							if (failure) notify?.(`${failure}; retrying attempt ${message.attempt}/${message.max_retries}`, "warning");
							break;
						}
					}
					break;
				case "rate_limit_event": {
					const rateLimitMessage = formatRateLimitMessage(message.rate_limit_info);
					debug("consumeQuery: rate_limit_event", JSON.stringify(message.rate_limit_info).slice(0, 300));
					if (message.rate_limit_info.status === "rejected") queryCtx.turnRateLimitRejection = rateLimitMessage;
					if (message.rate_limit_info.status !== "allowed") notify?.(rateLimitMessage, "warning");
					break;
				}
				case "assistant":
					processAssistantMessage(message, currentModel, customToolNameToPi, queryCtx);
					break;
				case "result":
					processResultMessage(message, currentModel, queryCtx);
					hooks.onResult(message);
					break;
				case "stream_event":
					processStreamEvent(message, customToolNameToPi, currentModel, queryCtx);
					break;
				case "user":
					break;
				default:
					if (queryCtx.currentPiStream && queryCtx.turnOutput) {
						debug("consumeQuery: unhandled SDK message type", message.type);
					}
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
	};
}
