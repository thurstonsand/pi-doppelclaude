import type {
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKMirrorErrorMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlock,
  RawMessageStreamEvent,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { parse as parsePartialJsonText } from "partial-json";
import { applySdkUsage, type CoreResponseHandle } from "./core-response.js";
import { withReloginHint } from "./dead-query.js";
import { recordSdkMessage } from "./debug.js";
import { canonicalClaudeModelId } from "./model-id.js";
import type { QueryContext } from "./query-state.js";
import { REFUSAL_CUSTOM_TYPE, type RefusalEntryData, refusalEntryData } from "./refusal-data.js";
import { resultErrorText } from "./sdk-result.js";
import {
  apiRetryableStatus,
  apiStatusFailure,
  assistantApiFailure,
  assistantRetryableStatus,
  classifyResult,
  formatRateLimitMessage,
  isSyntheticModelId,
} from "./sdk-signals.js";
import { diffSdkModelUsage } from "./sdk-usage.js";
import { isCcRejectedToolName, mapSdkToolNameToPi } from "./tool-names.js";

interface ProviderStreamDependencies {
  debug(...args: unknown[]): void;
  notify?(message: string, level: "warning"): void;
  appendEntry?(customType: string, data: RefusalEntryData): void;
  observeServedModel?(id: string): void;
}

export interface QueryConsumerHooks {
  onResult(message: SDKResultMessage): void;
  onSessionId(sessionId: string): void;
  onMirrorError?(message: SDKMirrorErrorMessage): void;
}

function parsePartialJson(
  input: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  if (!input) return fallback;
  try {
    const parsed = parsePartialJsonText(input);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

export function createProviderStreamRuntime(dependencies: ProviderStreamDependencies) {
  const { debug, notify, appendEntry, observeServedModel } = dependencies;
  const completedResponses = new WeakSet<object>();

  function claimCurrentResponse(
    response: CoreResponseHandle,
    label: string,
    c: QueryContext,
  ): void {
    if (c.currentResponse && !completedResponses.has(c.currentResponse)) {
      debug(
        `WARNING: currentResponse overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCallCount}`,
      );
    }
    if (c.rejectionWindowOpen) {
      debug(
        `provider: rejection window closed by ${label}; ${c.bufferedSdkMessages.length} buffered message(s)`,
      );
      c.rejectionWindowOpen = false;
    }
    c.currentResponse = response;
    c.turnOutput = response.record;
  }

  function openRejectionWindow(c: QueryContext, reason: string): void {
    if (c.rejectionWindowOpen) return;
    c.rejectionWindowOpen = true;
    debug(`provider: rejection window open (${reason})`);
  }

  function replayBufferedSdkMessages(c: QueryContext): void {
    if (!c.bufferedSdkMessages.length) return;
    const buffered = c.bufferedSdkMessages;
    c.bufferedSdkMessages = [];
    if (!c.dispatchSdkMessage)
      throw new Error(`Claude bridge: ${buffered.length} buffered SDK message(s) with no consumer`);
    for (const message of buffered) c.dispatchSdkMessage(message);
  }

  function flushStart(c: QueryContext): void {
    const response = c.currentResponse;
    if (!response || c.turnStarted) return;
    response.stream.push(
      response.pendingStart
        ? structuredClone(response.pendingStart)
        : { type: "message_start", message: structuredClone(response.record.message) },
    );
    response.pendingStart = undefined;
    c.turnStarted = true;
  }

  function closeResponse(c: QueryContext): void {
    const response = c.currentResponse;
    if (!response) return;
    flushStart(c);
    const terminal = c.terminalMessageDelta;
    response.stream.push(
      terminal
        ? {
            ...structuredClone(terminal),
            delta: {
              ...structuredClone(terminal.delta),
              stop_reason: response.record.message.stop_reason,
              stop_sequence: response.record.message.stop_sequence,
            },
            usage: structuredClone(response.record.message.usage),
          }
        : {
            type: "message_delta",
            delta: {
              container: response.record.message.container,
              stop_details: response.record.message.stop_details,
              stop_reason: response.record.message.stop_reason,
              stop_sequence: response.record.message.stop_sequence,
            },
            usage: structuredClone(response.record.message.usage),
          },
    );
    response.stream.push({ type: "message_stop" });
    response.record.lifecycle = "closed";
    response.stream.push({ type: "response", response: response.record });
    completedResponses.add(response);
    response.stream.end();
    c.currentResponse = null;
  }

  function emitTerminalError(c: QueryContext, reason: "aborted" | "error", message: string): void {
    recapServedModel(c);
    c.releasePendingToolCalls(message);
    const response = c.currentResponse;
    c.completeCommandUsage(
      response?.record.requestedModel ?? c.turnOutput?.requestedModel ?? c.activeModel ?? "unknown",
      null,
    );
    if (!response) return;
    const text = reason === "error" ? withReloginHint(message) : message;
    response.record.lifecycle = "failed";
    response.record.error = { reason, message: text };
    response.stream.push({
      type: "terminal_error",
      reason,
      message: text,
      ...(c.turnRetryableStatus ? { retryableStatus: c.turnRetryableStatus } : {}),
      response: response.record,
    });
    completedResponses.add(response);
    response.stream.end();
    c.currentResponse = null;
  }

  function finalizeCurrentResponse(c: QueryContext): void {
    if (!c.currentResponse || !c.turnOutput) return;
    if (c.turnOutput.error) {
      emitTerminalError(c, c.turnOutput.error.reason, c.turnOutput.error.message);
      return;
    }
    if (c.turnOutput.message.stop_reason === null) {
      emitTerminalError(c, "error", "Claude Code ended the turn without a stop reason");
      return;
    }
    closeResponse(c);
  }

  function noteServedModel(
    advertised: string | undefined,
    requested: string,
    c: QueryContext,
  ): void {
    if (!advertised || !c.turnOutput) return;
    const served = canonicalClaudeModelId(advertised);
    c.turnOutput.message.model = served;
    if (served === requested) return;
    observeServedModel?.(served);
    c.servedModelAnnouncement = { requested, served };
    const pair = `${requested}>${served}`;
    if (c.announcedServedPairs.has(pair)) return;
    c.announcedServedPairs.add(pair);
    c.commandFallbackRecapPending = true;
    notify?.(
      `Claude served ${served} instead of requested ${requested}; usage priced from served model`,
      "warning",
    );
  }

  function announceRefusal(
    message: SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage,
    c: QueryContext,
  ): void {
    // A safeguard fallback/no-fallback is not an upstream capacity failure, even if an
    // earlier envelope in this turn carried retry metadata.
    c.turnRetryableStatus = null;
    c.turnSafeguardRefusal = true;
    const data = refusalEntryData(message);
    if (c.persistent) appendEntry?.(REFUSAL_CUSTOM_TYPE, data);
    if (!data.servedModel) return;
    c.servedModelAnnouncement = { requested: data.requestedModel, served: data.servedModel };
    c.commandFallbackRecapPending = false;
    c.announcedServedPairs.add(`${data.requestedModel}>${data.servedModel}`);
    observeServedModel?.(data.servedModel);
  }

  function recapServedModel(c: QueryContext): void {
    if (!c.commandFallbackRecapPending || !c.servedModelAnnouncement) return;
    const { requested, served } = c.servedModelAnnouncement;
    notify?.(
      `Turn served by ${served}, not ${requested}; usage priced from served model`,
      "warning",
    );
    c.commandFallbackRecapPending = false;
  }

  function noteRejectedToolCallNames(c: QueryContext): void {
    const rejected = c.turnBlocks.filter(
      (block): block is ToolUseBlock =>
        block.type === "tool_use" && isCcRejectedToolName(block.name),
    );
    for (const block of rejected) c.rejectedToolCallIds.add(block.id);
    if (rejected.length)
      openRejectionWindow(c, `Claude Code has no tool ${rejected.map((b) => b.name).join(", ")}`);
  }

  function noteRejectedToolResults(message: SDKUserMessage, c: QueryContext): void {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
      const id = block.type === "tool_result" ? block.tool_use_id : undefined;
      if (!id || !c.shownToolCallIds.has(id) || c.dispatchedToolCallIds.has(id)) continue;
      c.rejectedToolCallIds.add(id);
      if (!c.currentResponse) openRejectionWindow(c, `undispatched tool call [${id}]`);
    }
  }

  function pushNativeEvent(event: RawMessageStreamEvent, c: QueryContext): void {
    if (!c.currentResponse) return;
    if (event.type === "message_start") {
      c.currentResponse.pendingStart = structuredClone(event);
      return;
    }
    flushStart(c);
    c.currentResponse.stream.push(structuredClone(event));
  }

  function processStreamEvent(
    message: SDKMessage,
    customToolNameToPi: Map<string, string>,
    requestedModel: string,
    c: QueryContext,
  ): void {
    if (!c.currentResponse || !c.turnOutput) return;
    c.turnSawStreamEvent = true;
    const event = (message as SDKPartialAssistantMessage).event as RawMessageStreamEvent;
    if (!event) return;
    const output = c.turnOutput.message;
    if (event.type === "message_start") {
      noteServedModel(event.message.model, requestedModel, c);
      applySdkUsage(output, event.message.usage);
      c.currentResponse.pendingStart = {
        ...structuredClone(event),
        message: structuredClone(output),
      };
      return;
    }
    if (event.type === "content_block_start") {
      const block = structuredClone(event.content_block) as ContentBlock;
      if (block.type === "tool_use") {
        c.turnSawToolCall = true;
        c.shownToolCallIds.add(block.id);
        block.name = mapSdkToolNameToPi(block.name, customToolNameToPi);
      }
      output.content.push(block);
      c.openStreamBlocks.set(event.index, {
        contentIndex: output.content.length - 1,
        partialJson: "",
      });
      pushNativeEvent({ ...event, content_block: block }, c);
      return;
    }
    if (event.type === "content_block_delta") {
      const open = c.openStreamBlocks.get(event.index);
      const block = open && output.content[open.contentIndex];
      if (open && block) {
        if (event.delta.type === "text_delta" && block.type === "text")
          block.text += event.delta.text;
        else if (event.delta.type === "thinking_delta" && block.type === "thinking")
          block.thinking += event.delta.thinking;
        else if (event.delta.type === "signature_delta" && block.type === "thinking")
          block.signature += event.delta.signature;
        else if (event.delta.type === "input_json_delta" && block.type === "tool_use") {
          open.partialJson += event.delta.partial_json;
          block.input = parsePartialJson(open.partialJson, block.input as Record<string, unknown>);
        }
      }
      pushNativeEvent(event, c);
      return;
    }
    if (event.type === "content_block_stop") c.openStreamBlocks.delete(event.index);
    if (event.type === "message_delta") {
      output.stop_reason = event.delta.stop_reason;
      output.stop_sequence = event.delta.stop_sequence;
      if (event.delta.stop_reason) c.turnOutput.rawStopReason = event.delta.stop_reason;
      // Claude Code's wire protocol has stop reasons newer than the public SDK union.
      switch (event.delta.stop_reason as string | null) {
        case null:
        case "end_turn":
        case "stop_sequence":
        case "pause_turn":
        case "max_tokens":
        case "tool_use":
          break;
        case "refusal":
          c.turnRetryableStatus = null;
          c.turnSafeguardRefusal = true;
          c.turnOutput.error = {
            reason: "error",
            message: "The model refused to complete the request",
          };
          break;
        case "sensitive":
          c.turnRetryableStatus = null;
          c.turnSafeguardRefusal = true;
          c.turnOutput.error = { reason: "error", message: "Provider stopped with: sensitive" };
          break;
        case "model_context_window_exceeded":
          c.turnOutput.error = {
            reason: "error",
            message: "The conversation exceeded the model's context window",
          };
          break;
        default:
          c.turnOutput.error = {
            reason: "error",
            message: `Unhandled stop reason: ${event.delta.stop_reason}`,
          };
          break;
      }
      applySdkUsage(output, event.usage);
      c.terminalMessageDelta = structuredClone(event);
      return;
    }
    if (event.type === "message_stop") {
      if (!c.turnSawToolCall) return;
      output.stop_reason = "tool_use";
      noteRejectedToolCallNames(c);
      closeResponse(c);
      return;
    }
    pushNativeEvent(event, c);
  }

  function processAssistantMessage(
    message: SDKAssistantMessage,
    requestedModel: string,
    customToolNameToPi: Map<string, string>,
    c: QueryContext,
  ): void {
    if (message.aborted) c.turnSawAbortedAssistant = true;
    c.turnApiFailure ??= assistantApiFailure(message.error);
    c.turnRetryableStatus ??= assistantRetryableStatus(message.error);
    if (isSyntheticModelId(message.message?.model)) {
      const text = (message.message?.content ?? [])
        .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
        .join("\n")
        .trim();
      if (text) c.turnSyntheticText = text;
      return;
    }
    noteServedModel(message.message?.model, requestedModel, c);
    if (c.turnSawStreamEvent || !message.message?.content || !c.currentResponse) return;
    const blocks = structuredClone(message.message.content) as ContentBlock[];
    c.turnSawAssistantContent = blocks.length > 0;
    for (const block of blocks) {
      if (block.type === "tool_use") {
        c.turnSawToolCall = true;
        c.shownToolCallIds.add(block.id);
        block.name = mapSdkToolNameToPi(block.name, customToolNameToPi);
      }
      c.turnBlocks.push(block);
      const index = c.turnBlocks.length - 1;
      const start = structuredClone(block);
      if (start.type === "text") start.text = "";
      else if (start.type === "thinking") {
        start.thinking = "";
        start.signature = "";
      } else if (start.type === "tool_use") start.input = {};
      pushNativeEvent({ type: "content_block_start", index, content_block: start }, c);
      if (block.type === "text" && block.text)
        pushNativeEvent(
          { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
          c,
        );
      else if (block.type === "thinking") {
        if (block.thinking)
          pushNativeEvent(
            {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: block.thinking },
            },
            c,
          );
        if (block.signature)
          pushNativeEvent(
            {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: block.signature },
            },
            c,
          );
      } else if (block.type === "tool_use")
        pushNativeEvent(
          {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          },
          c,
        );
      pushNativeEvent({ type: "content_block_stop", index }, c);
    }
    if (message.message.usage) applySdkUsage(c.turnOutput.message, message.message.usage);
    if (c.turnSawToolCall) {
      c.turnOutput.message.stop_reason = "tool_use";
      closeResponse(c);
      noteRejectedToolCallNames(c);
    }
  }

  function processResultMessage(
    message: SDKResultMessage,
    requestedModel: string,
    c: QueryContext,
  ): void {
    const modelUsage = diffSdkModelUsage(message.modelUsage, c.modelUsageSnapshot);
    c.modelUsageSnapshot = structuredClone(message.modelUsage);
    c.completeCommandUsage(requestedModel, modelUsage);
    for (const usage of Object.values(modelUsage))
      noteServedModel(usage.canonicalModel, requestedModel, c);
    recapServedModel(c);
    const apiErrorStatus = message.subtype === "success" ? message.api_error_status : undefined;
    const statusFailure = apiStatusFailure(apiErrorStatus);
    const detail =
      message.subtype !== "success" || message.is_error
        ? (c.turnSyntheticText ?? resultErrorText(message))
        : null;
    c.turnResultVerdict = classifyResult(
      message,
      c.turnRateLimitRejection ?? c.turnApiFailure ?? statusFailure,
      detail,
    );
    if (c.turnResultVerdict.type === "interrupted" || c.turnSafeguardRefusal)
      c.turnRetryableStatus = null;
    else if (c.turnResultVerdict.type === "terminal")
      c.turnRetryableStatus ??= apiRetryableStatus(apiErrorStatus);
    if (!c.turnOutput) return;
    if (c.turnResultVerdict.type !== "reusable") {
      c.turnOutput.error = { reason: "error", message: c.turnResultVerdict.message };
      return;
    }
    if (c.turnOutput.message.stop_reason === null) c.turnOutput.message.stop_reason = "end_turn";
    if (!c.turnSawStreamEvent && !c.turnSawAssistantContent && c.currentResponse) {
      const text = message.subtype === "success" ? message.result : "";
      const block: ContentBlock = { type: "text", text: "", citations: null };
      c.turnBlocks.push(block);
      const index = c.turnBlocks.length - 1;
      pushNativeEvent({ type: "content_block_start", index, content_block: block }, c);
      pushNativeEvent(
        { type: "content_block_delta", index, delta: { type: "text_delta", text } },
        c,
      );
      block.text = text;
      pushNativeEvent({ type: "content_block_stop", index }, c);
    }
  }

  function drivesResponse(message: SDKMessage): boolean {
    return (
      message.type === "stream_event" || message.type === "assistant" || message.type === "result"
    );
  }

  function dispatchSdkMessage(
    message: SDKMessage,
    customToolNameToPi: Map<string, string>,
    requestedModel: string,
    c: QueryContext,
    hooks: QueryConsumerHooks,
  ): void {
    const currentModel = c.activeModel ?? requestedModel;
    switch (message.type) {
      case "system":
        if (message.subtype === "init") hooks.onSessionId(message.session_id);
        else if (message.subtype === "mirror_error") hooks.onMirrorError?.(message);
        else if (message.subtype === "api_retry") {
          const failure =
            apiStatusFailure(message.error_status) ?? assistantApiFailure(message.error);
          if (failure)
            notify?.(
              `${failure}; retrying attempt ${message.attempt}/${message.max_retries}`,
              "warning",
            );
        } else if (
          message.subtype === "model_refusal_fallback" ||
          message.subtype === "model_refusal_no_fallback"
        )
          announceRefusal(message, c);
        break;
      case "rate_limit_event": {
        const text = formatRateLimitMessage(message.rate_limit_info);
        if (message.rate_limit_info.status === "rejected") {
          c.turnRateLimitRejection = text;
          c.turnRetryableStatus = 429;
        }
        if (message.rate_limit_info.status !== "allowed") notify?.(text, "warning");
        break;
      }
      case "assistant":
        processAssistantMessage(message, currentModel, customToolNameToPi, c);
        break;
      case "result":
        processResultMessage(message, currentModel, c);
        hooks.onResult(message);
        break;
      case "stream_event":
        processStreamEvent(message, customToolNameToPi, currentModel, c);
        break;
      case "user":
        noteRejectedToolResults(message, c);
        break;
    }
  }

  async function consumeQuery(
    sdkQuery: Query,
    customToolNameToPi: Map<string, string>,
    requestedModel: string,
    queryCtx: QueryContext,
    hooks: QueryConsumerHooks,
  ): Promise<void> {
    queryCtx.dispatchSdkMessage = (message) =>
      dispatchSdkMessage(message, customToolNameToPi, requestedModel, queryCtx, hooks);
    for await (const message of sdkQuery) {
      recordSdkMessage(message);
      if (queryCtx.rejectionWindowOpen && drivesResponse(message)) {
        queryCtx.bufferedSdkMessages.push(message);
        continue;
      }
      queryCtx.dispatchSdkMessage(message);
    }
  }

  return {
    claimCurrentResponse,
    emitTerminalError,
    finalizeCurrentResponse,
    replayBufferedSdkMessages,
    consumeQuery,
  };
}
