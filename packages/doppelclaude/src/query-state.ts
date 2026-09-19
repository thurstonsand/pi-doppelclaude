// Query state: the QueryContext class.
//
// All per-query and per-turn mutable state lives on one instance. Every context
// belongs to exactly one doppel: its own, plus a fresh instance per reentrant
// (subagent) query. Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlock,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages";
import {
  type CommandUsageObservation,
  type CoreResponseEvent,
  type CoreResponseHandle,
  type CoreResponseRecord,
  createCommandId,
  createCoreResponse,
  type PushStream,
  type RetryableStatus,
} from "./core-response.js";
import type { Doppel } from "./doppel.js";
import type { McpResult } from "./extract-tool-results.js";
import type { ResultVerdict } from "./sdk-signals.js";
import type { SdkModelUsage } from "./sdk-usage.js";
import type { SessionStoreWriter } from "./session-store.js";

interface PendingToolCall {
  toolName: string;
  resolve: (result: McpResult) => void;
}

/** A content block Anthropic has started but not yet stopped. */
export interface OpenStreamBlock {
  /** Position of the block in `turnOutput.content`. */
  contentIndex: number;
  /** Tool arguments accumulated so far, parseable only once the block stops. */
  partialJson: string;
}

export type TerminalMessageDelta = Extract<RawMessageStreamEvent, { type: "message_delta" }>;

export interface LocalSessionFragment {
  sessionId: string;
  cwd: string;
  claudeDir?: string;
}

export class PushQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(value: T): void {
    if (this.ended) throw new Error("Cannot push to an ended input queue");
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value, done: false });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}

export class QueryContext {
  /** The conversation this context speaks for. Set once, by the doppel that made it. */
  constructor(readonly doppel: Doppel) {}

  // Query-scoped: reassigned by spawnFreshQuery for every query this context serves.
  activeQuery: Query | null = null;
  inputQueue: PushQueue<SDKUserMessage> | null = null;
  sessionStoreWriter: SessionStoreWriter | null = null;
  currentResponse: CoreResponseHandle | null = null;
  fatalError: string | null = null;
  latestCursor = 0;
  readyForInput = false;
  persistent = false;
  closing = false;
  spawnSignature: string | null = null;
  mcpSignature: string | null = null;
  hasMcpServer = false;
  cliModel: string | null = null;
  modelUsageSnapshot: SdkModelUsage = {};
  commandId = createCommandId();
  commandOutputs: CoreResponseRecord[] = [];
  commandUsageCompleted = false;
  observeCommandUsage: ((observation: CommandUsageObservation) => void) | null = null;
  announcedServedPairs = new Set<string>();
  servedModelAnnouncement: { requested: string; served: string } | null = null;
  commandFallbackRecapPending = false;
  activeModel: string | null = null;
  abortCleanup: (() => void) | null = null;
  completion: Promise<void> | null = null;
  closeCompletion: Promise<void> | null = null;
  localSessionFragment: LocalSessionFragment | null = null;
  turnAborted = false;
  turnSawAbortedAssistant = false;
  turnInterruptReceiptReceived = false;
  turnInterruptQueuedIds: string[] = [];
  turnResultVerdict: ResultVerdict | null = null;
  turnApiFailure: string | null = null;
  turnRateLimitRejection: string | null = null;
  turnRetryableStatus: RetryableStatus | null = null;
  turnSafeguardRefusal = false;
  turnSyntheticText: string | null = null;
  // Respawns and replays the turn once when the query dies before any of it reaches pi.
  // Live only from the turn's start until the turn advances, so a failure after pi has
  // moved on cannot replay a stale context.
  turnRetry: (() => void) | null = null;
  // An MCP handler blocking on pi is a promise held inside the in-process MCP server and,
  // through it, a Claude Code request waiting on an answer. Losing one hangs both for the
  // life of the process, so the map is private: every way out of it is a method below, and
  // there is no way to drop an entry without answering it.
  #pendingToolCalls = new Map<string, PendingToolCall>();
  pendingResults = new Map<string, McpResult>();
  // Reconciliation is order-independent: a tool call is shown to pi when it is
  // streamed, dispatched when Claude Code invokes its MCP handler, and rejected
  // when Claude Code answers it without ever dispatching it.
  shownToolCallIds = new Set<string>();
  dispatchedToolCallIds = new Set<string>();
  rejectedToolCallIds = new Set<string>();
  // While a rejection has removed the MCP handler's backpressure, SDK messages
  // that drive the pi stream are held here instead of discarded, and replayed
  // when pi claims its next stream.
  rejectionWindowOpen = false;
  bufferedSdkMessages: SDKMessage[] = [];
  dispatchSdkMessage: ((message: SDKMessage) => void) | null = null;

  // Per-turn (reset together)
  turnOutput: CoreResponseRecord | null = null;
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;
  turnSawAssistantContent = false;
  // The SDK emits its message_delta/message_stop before its result envelope. Keep the
  // terminal delta for state and wire fidelity, but do not expose successful completion
  // until the result has supplied the actual verdict.
  terminalMessageDelta: TerminalMessageDelta | null = null;

  // Anthropic addresses a streaming block by its own event index and feeds tool arguments
  // in as JSON fragments; pi addresses content by position and wants whole arguments. This
  // holds that translation for the blocks still open, so nothing transient has to ride on
  // the pi content blocks themselves.
  openStreamBlocks = new Map<number, OpenStreamBlock>();

  /** The handler waits here until pi answers the call, which is the backpressure that keeps
   *  Claude Code from running ahead of pi. */
  blockOnToolResult(toolCallId: string, toolName: string): Promise<McpResult> {
    return new Promise<McpResult>((resolve) => {
      this.#pendingToolCalls.set(toolCallId, { toolName, resolve });
    });
  }

  hasPendingToolCall(toolCallId: string): boolean {
    return this.#pendingToolCalls.has(toolCallId);
  }

  get pendingToolCallCount(): number {
    return this.#pendingToolCalls.size;
  }

  get pendingToolCallIds(): string[] {
    return [...this.#pendingToolCalls.keys()];
  }

  /** Answers one blocked handler; returns the tool it was waiting for, or null if no handler
   *  had fired for that call yet. */
  deliverToolResult(toolCallId: string, result: McpResult): string | null {
    const pending = this.#pendingToolCalls.get(toolCallId);
    if (!pending) return null;
    this.#pendingToolCalls.delete(toolCallId);
    pending.resolve(result);
    return pending.toolName;
  }

  /** Every handler still blocked, answered at once because the turn they were waiting on is
   *  over. Whatever ends a turn ends these with it. */
  releasePendingToolCalls(text: string): void {
    for (const pending of this.#pendingToolCalls.values())
      pending.resolve({ content: [{ type: "text", text }] });
    this.#pendingToolCalls.clear();
  }

  get turnBlocks(): ContentBlock[] {
    if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
    return this.turnOutput.message.content;
  }

  beginCommand(model: string, stream: PushStream<CoreResponseEvent>): void {
    this.commandId = createCommandId();
    this.commandOutputs = [];
    this.commandUsageCompleted = false;
    this.commandFallbackRecapPending = false;
    // The buffer belongs to the command that opened its window; a new command
    // must never inherit the previous one's unreplayed messages.
    this.rejectionWindowOpen = false;
    this.bufferedSdkMessages = [];
    this.resetTurnState(model, stream);
  }

  completeCommandUsage(requestedModel: string, modelUsage: SdkModelUsage | null): void {
    if (this.commandUsageCompleted) return;
    this.commandUsageCompleted = true;
    this.observeCommandUsage?.({
      commandId: this.commandId,
      requestedModel,
      responseIds: this.commandOutputs.map((output) => output.id),
      modelUsage: modelUsage ? structuredClone(modelUsage) : null,
    });
    this.commandOutputs = [];
  }

  /** A replay re-runs the turn that just died, so the output it abandoned leaves the
   *  command's record instead of standing in it as a turn that produced nothing. */
  restartTurnState(model: string, stream: PushStream<CoreResponseEvent>): void {
    const abandoned = this.turnOutput ? this.commandOutputs.lastIndexOf(this.turnOutput) : -1;
    if (abandoned >= 0) this.commandOutputs.splice(abandoned, 1);
    this.resetTurnState(model, stream);
  }

  resetTurnState(model: string, stream: PushStream<CoreResponseEvent>): void {
    this.currentResponse = createCoreResponse(this.commandId, model, stream);
    this.turnOutput = this.currentResponse.record;
    this.commandOutputs.push(this.turnOutput);
    this.turnStarted = false;
    this.turnSawStreamEvent = false;
    this.turnSawToolCall = false;
    this.turnSawAssistantContent = false;
    this.terminalMessageDelta = null;
    this.turnAborted = false;
    this.turnSawAbortedAssistant = false;
    this.turnInterruptReceiptReceived = false;
    this.turnInterruptQueuedIds = [];
    this.turnResultVerdict = null;
    this.turnApiFailure = null;
    this.turnRateLimitRejection = null;
    this.turnRetryableStatus = null;
    this.turnSafeguardRefusal = false;
    this.turnSyntheticText = null;
    this.turnRetry = null;
    this.openStreamBlocks.clear();
    this.readyForInput = false;
  }
}
