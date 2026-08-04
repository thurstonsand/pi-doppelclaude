// Query state: the QueryContext class.
//
// All per-query and per-turn mutable state lives on one instance. Every context
// belongs to exactly one doppel: its own, plus a fresh instance per reentrant
// (subagent) query. Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type { Doppel } from "./doppel.js";
import type { McpResult } from "./extract-tool-results.js";
import type { ResultVerdict } from "./sdk-signals.js";
import type { SdkModelUsage } from "./sdk-usage.js";
import type { SessionStoreWriter } from "./session-store.js";

export interface PendingToolCall {
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

  // Query-scoped (fully isolated per query)
  activeQuery: Query | null = null;
  inputQueue: PushQueue<SDKUserMessage> | null = null;
  sessionStoreWriter: SessionStoreWriter | null = null;
  currentPiStream: AssistantMessageEventStream | null = null;
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
  commandOutputs: AssistantMessage[] = [];
  announcedServedPairs = new Set<string>();
  servedModelAnnouncement: { requested: string; served: string } | null = null;
  commandFallbackRecapPending = false;
  activeModel: Model<Api> | null = null;
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
  turnSyntheticText: string | null = null;
  // Respawns and replays the turn once when the query dies before any of it reaches pi.
  // Live only from the turn's start until the turn advances, so a failure after pi has
  // moved on cannot replay a stale context.
  turnRetry: (() => void) | null = null;
  pendingToolCalls = new Map<string, PendingToolCall>();
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
  turnOutput: AssistantMessage | null = null;
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;

  // Anthropic addresses a streaming block by its own event index and feeds tool arguments
  // in as JSON fragments; pi addresses content by position and wants whole arguments. This
  // holds that translation for the blocks still open, so nothing transient has to ride on
  // the pi content blocks themselves.
  openStreamBlocks = new Map<number, OpenStreamBlock>();

  get turnBlocks(): AssistantMessage["content"] {
    if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
    return this.turnOutput.content;
  }

  beginCommand(model: Model<Api>): void {
    this.commandOutputs = [];
    this.commandFallbackRecapPending = false;
    // The buffer belongs to the command that opened its window; a new command
    // must never inherit the previous one's unreplayed messages.
    this.rejectionWindowOpen = false;
    this.bufferedSdkMessages = [];
    this.resetTurnState(model);
  }

  /** A replay re-runs the turn that just died, so the output it abandoned leaves the
   *  command's record instead of standing in it as a turn that produced nothing. */
  restartTurnState(model: Model<Api>): void {
    const abandoned = this.turnOutput ? this.commandOutputs.lastIndexOf(this.turnOutput) : -1;
    if (abandoned >= 0) this.commandOutputs.splice(abandoned, 1);
    this.resetTurnState(model);
  }

  resetTurnState(model: Model<Api>): void {
    this.turnOutput = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "pending",
      timestamp: Date.now(),
    };
    this.commandOutputs.push(this.turnOutput);
    this.turnStarted = false;
    this.turnSawStreamEvent = false;
    this.turnSawToolCall = false;
    this.turnAborted = false;
    this.turnSawAbortedAssistant = false;
    this.turnInterruptReceiptReceived = false;
    this.turnInterruptQueuedIds = [];
    this.turnResultVerdict = null;
    this.turnApiFailure = null;
    this.turnRateLimitRejection = null;
    this.turnSyntheticText = null;
    this.turnRetry = null;
    this.openStreamBlocks.clear();
    this.readyForInput = false;
  }
}
