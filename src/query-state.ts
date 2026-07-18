// Query state: QueryContext class + context stack.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) push the parent context onto a stack and get a fresh instance.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpResult } from "./extract-tool-results.js";
import type { SessionStoreWriter } from "./session-store.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface ActiveQuery {
	interrupt(): Promise<void>;
	setModel(model?: string): Promise<void>;
	close(): void;
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
				return new Promise<IteratorResult<T>>((resolve) => { this.waiter = resolve; });
			},
		};
	}
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: ActiveQuery | null = null;
	inputQueue: PushQueue<SDKUserMessage> | null = null;
	sessionStoreWriter: SessionStoreWriter | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	fatalError: string | null = null;
	latestCursor = 0;
	readyForInput = false;
	persistent = false;
	closing = false;
	spawnSignature: string | null = null;
	cliModel: string | null = null;
	activeModel: Model<any> | null = null;
	abortCleanup: (() => void) | null = null;
	completion: Promise<void> | null = null;
	closeCompletion: Promise<void> | null = null;
	localSessionFragment: LocalSessionFragment | null = null;
	turnAborted = false;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.readyForInput = false;
		// turnToolCallIds is not reset — it persists across tool-result delivery
		// callbacks within the same assistant message.
	}
}

let _ctx = new QueryContext();
const contextStack: QueryContext[] = [];

export function ctx(): QueryContext { return _ctx; }

export function stackDepth(): number { return contextStack.length; }

export function pushContext(): void {
	if (!_ctx.activeQuery) throw new Error("pushContext() called with no active query");
	contextStack.push(_ctx);
	_ctx = new QueryContext();
}

export function popContext(): void {
	if (contextStack.length === 0) throw new Error("popContext() called with empty stack");
	_ctx = contextStack.pop()!;
}

// Test-only: drop all state so test files can start from a clean module.
// Not called from production.
export function resetStack(): void {
	_ctx = new QueryContext();
	contextStack.length = 0;
}
