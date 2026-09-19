import type {
  ContentBlock,
  Message,
  RawMessageStreamEvent,
  Usage,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { SdkModelUsage } from "./sdk-usage.js";

export type CoreStopReason = Message["stop_reason"] | "aborted" | "error";
export type RetryableStatus = 429 | 529;

export interface CoreTerminalError {
  type: "terminal_error";
  reason: "aborted" | "error";
  message: string;
  retryableStatus?: RetryableStatus;
  response: CoreResponseRecord;
}

export interface CoreResponseResult {
  type: "response";
  response: CoreResponseRecord;
}

export type CoreResponseEvent = RawMessageStreamEvent | CoreTerminalError | CoreResponseResult;

export interface CommandUsageObservation {
  commandId: string;
  requestedModel: string;
  responseIds: string[];
  modelUsage: SdkModelUsage | null;
}

export interface CoreResponseRecord {
  readonly commandId: string;
  readonly id: string;
  readonly requestedModel: string;
  message: Message;
  lifecycle: "open" | "closed" | "failed";
  error: { reason: "aborted" | "error"; message: string } | null;
  rawStopReason?: string;
}

export interface PushStream<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
}

let nextCommandId = 0;
let nextResponseId = 0;

export function createCommandId(): string {
  return `command_${++nextCommandId}`;
}

export function emptyUsage(): Usage {
  return {
    cache_creation: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

export function createCoreResponse(
  commandId: string,
  requestedModel: string,
  stream: PushStream<CoreResponseEvent>,
): CoreResponseHandle {
  const id = `response_${++nextResponseId}`;
  return {
    stream,
    record: {
      commandId,
      id,
      requestedModel,
      lifecycle: "open",
      error: null,
      message: {
        id,
        type: "message",
        role: "assistant",
        container: null,
        content: [],
        model: requestedModel,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: emptyUsage(),
      },
    },
  };
}

export interface CoreResponseHandle {
  readonly stream: PushStream<CoreResponseEvent>;
  readonly record: CoreResponseRecord;
  pendingStart?: RawMessageStreamEvent;
}

export function applySdkUsage(message: Message, usage: Partial<Usage> | null | undefined): void {
  if (!usage) return;
  const target = message.usage as Usage & Record<string, unknown>;
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number") target[key] = value;
    else if (value !== undefined && value !== null) target[key] = value;
  }
}

export function nativeContent(message: Message): ContentBlock[] {
  return message.content;
}
