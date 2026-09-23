import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type JsonObject,
  type Model,
  type StopReason,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type {
  CommandUsageObservation,
  CoreResponseEvent,
  CoreResponseRecord,
} from "doppelclaude/core-response";
import { PushQueue } from "doppelclaude/query-state";
import { parse as parsePartialJsonText } from "partial-json";
import { applySdkUsage, reconcileSdkModelUsage } from "./pi-usage.js";

function stopReason(record: CoreResponseRecord): { reason: StopReason; error?: string } {
  if (record.error) return { reason: record.error.reason, error: record.error.message };
  switch (record.message.stop_reason as string | null) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return { reason: "stop" };
    case "max_tokens":
      return { reason: "length" };
    case "tool_use":
      return { reason: "toolUse" };
    case "refusal":
      return { reason: "error", error: "The model refused to complete the request" };
    case "sensitive":
      return { reason: "error", error: "Provider stopped with: sensitive" };
    case "model_context_window_exceeded":
      return { reason: "error", error: "The conversation exceeded the model's context window" };
    default:
      return { reason: "error", error: `Unhandled stop reason: ${record.message.stop_reason}` };
  }
}

function createMessage(model: Model<Api>, record: CoreResponseRecord): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: record.message.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    responseId: record.id,
    timestamp: Date.now(),
  };
}

export interface PiResponseAdapter {
  readonly native: PushQueue<CoreResponseEvent>;
  readonly stream: AssistantMessageEventStream;
}

/** Command-scoped accounting deliberately outlives individual streams: the SDK result for a
 * tool command arrives after its tool-use response has already closed. */
export function createPiResponseRuntime() {
  const messages = new Map<string, AssistantMessage>();
  const terminalResponses = new Set<string>();
  const pendingUsage = new Map<
    string,
    { observation: CommandUsageObservation; model: Model<Api> }
  >();

  function reconcileUsage(observation: CommandUsageObservation, model: Model<Api>): boolean {
    const outputs = observation.responseIds.flatMap((id) => {
      const output = messages.get(id);
      return output ? [output] : [];
    });
    if (
      outputs.length !== observation.responseIds.length ||
      observation.responseIds.some((id) => !terminalResponses.has(id))
    )
      return false;
    if (observation.modelUsage) reconcileSdkModelUsage(outputs, observation.modelUsage, model);
    pendingUsage.delete(observation.commandId);
    for (const id of observation.responseIds) {
      messages.delete(id);
      terminalResponses.delete(id);
    }
    return true;
  }

  function retryPendingUsage(): void {
    for (const { observation, model } of pendingUsage.values()) reconcileUsage(observation, model);
  }

  function observeUsage(observation: CommandUsageObservation, model: Model<Api>): void {
    if (!reconcileUsage(observation, model))
      pendingUsage.set(observation.commandId, { observation, model });
  }

  function adapt(model: Model<Api>): PiResponseAdapter {
    const native = new PushQueue<CoreResponseEvent>();
    const stream = createAssistantMessageEventStream();
    let output: AssistantMessage | undefined;
    const openBlocks = new Map<number, number>();
    const partialToolJson = new Map<number, string>();

    queueMicrotask(async () => {
      for await (const event of native) {
        if (event.type === "message_start") {
          output ??= createMessage(model, {
            commandId: "",
            id: event.message.id,
            requestedModel: model.id,
            message: event.message,
            lifecycle: "open",
            error: null,
          });
          messages.set(event.message.id, output);
          applySdkUsage(output, event.message.usage, model);
          stream.push({ type: "start", partial: output });
        } else if (event.type === "content_block_start" && output) {
          const index = output.content.length;
          const block = event.content_block;
          if (block.type === "text") {
            openBlocks.set(event.index, index);
            output.content.push({ type: "text", text: block.text });
            stream.push({ type: "text_start", contentIndex: index, partial: output });
          } else if (block.type === "thinking") {
            openBlocks.set(event.index, index);
            output.content.push({
              type: "thinking",
              thinking: block.thinking,
              thinkingSignature: block.signature,
            });
            stream.push({ type: "thinking_start", contentIndex: index, partial: output });
          } else if (block.type === "tool_use") {
            openBlocks.set(event.index, index);
            partialToolJson.set(event.index, "");
            output.content.push({
              type: "toolCall",
              id: block.id,
              name: block.name,
              arguments: (block.input as JsonObject) ?? {},
            });
            stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
          }
        } else if (event.type === "content_block_delta" && output) {
          const index = openBlocks.get(event.index);
          if (index === undefined) continue;
          const block = output.content[index];
          if (event.delta.type === "text_delta" && block.type === "text") {
            block.text += event.delta.text;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: event.delta.text,
              partial: output,
            });
          } else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: event.delta.thinking,
              partial: output,
            });
          } else if (event.delta.type === "signature_delta" && block.type === "thinking") {
            block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
          } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
            const json = (partialToolJson.get(event.index) ?? "") + event.delta.partial_json;
            partialToolJson.set(event.index, json);
            try {
              const parsed = parsePartialJsonText(json);
              if (typeof parsed === "object" && parsed !== null)
                block.arguments = parsed as JsonObject;
            } catch {}
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: event.delta.partial_json,
              partial: output,
            });
          }
        } else if (event.type === "content_block_stop" && output) {
          const index = openBlocks.get(event.index);
          if (index === undefined) continue;
          openBlocks.delete(event.index);
          partialToolJson.delete(event.index);
          const block = output.content[index];
          if (block.type === "text")
            stream.push({
              type: "text_end",
              contentIndex: index,
              content: block.text,
              partial: output,
            });
          else if (block.type === "thinking")
            stream.push({
              type: "thinking_end",
              contentIndex: index,
              content: block.thinking,
              partial: output,
            });
          else if (block.type === "toolCall")
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: block as ToolCall,
              partial: output,
            });
        } else if (event.type === "message_delta" && output) {
          applySdkUsage(output, event.usage, model);
        } else if (event.type === "response" || event.type === "terminal_error") {
          if (!output) {
            output = createMessage(model, event.response);
            stream.push({ type: "start", partial: output });
          }
          messages.set(event.response.id, output);
          output.model = event.response.message.model;
          const supported = event.response.message.content.filter(
            (block) =>
              block.type === "text" || block.type === "thinking" || block.type === "tool_use",
          );
          for (let index = 0; index < supported.length; index++) {
            const source = supported[index];
            const target = output.content[index];
            if (source?.type === "text" && target?.type === "text") target.text = source.text;
            else if (source?.type === "thinking" && target?.type === "thinking") {
              target.thinking = source.thinking;
              target.thinkingSignature = source.signature;
            } else if (source?.type === "tool_use" && target?.type === "toolCall") {
              target.name = source.name;
              target.arguments = source.input as JsonObject;
            }
          }
          applySdkUsage(output, event.response.message.usage, model);
          terminalResponses.add(event.response.id);
          retryPendingUsage();
          const terminal = stopReason(event.response);
          output.stopReason = terminal.reason;
          output.errorMessage = terminal.error;
          if (event.response.rawStopReason)
            (output as AssistantMessage & { rawStopReason?: string }).rawStopReason =
              event.response.rawStopReason;
          if (terminal.reason === "error" || terminal.reason === "aborted")
            stream.push({ type: "error", reason: terminal.reason, error: output });
          else if (terminal.reason !== "pending")
            stream.push({ type: "done", reason: terminal.reason, message: output });
          stream.end(output);
        }
      }
    });
    return { native, stream };
  }

  return { adapt, observeUsage };
}
