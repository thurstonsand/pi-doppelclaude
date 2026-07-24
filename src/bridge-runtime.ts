// Bridge runtime: the persistent query/session/MCP state machine.
//
// Owns the shared Claude Code session, the SDK-backed transcript store, the root
// and reentrant QueryContexts, the active-query set, MCP pending-result routing,
// the persistent input queue, and the full query lifecycle.

import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createSdkMcpServer, query, type McpServerConfig, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createSession, deleteSession, repairToolPairing } from "cc-session-io";
import { messageContentToText, convertPiMessages } from "./convert.js";
import { claudeCodeModelId, resolveThinkingEffort } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { PushQueue, QueryContext } from "./query-state.js";
import type { ProviderSettings } from "./settings.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import { buildClaudeSystemPrompt, settingSourcesFor } from "./system-prompt.js";
import { createProviderStreamRuntime } from "./provider-stream.js";
import { BridgeSessionStore, MalformedSessionTranscriptError } from "./session-store.js";
import { awaitQueryInitialization, reconcileMcpServers } from "./sdk-signals.js";
import { debug, diagDump, errorMessage, makeCliDebugOptions, sdkChildEnv } from "./debug.js";

export interface BridgeRuntimeDependencies {
	providerSettings: ProviderSettings;
	queryFactory?(request: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
	sessionStore?: BridgeSessionStore;
}

interface SessionState {
	sessionId: string;
	cursor: number;
	// Force the next syncSharedSession call down the REBUILD path when pi has
	// mutated its messages array out from under us (compact, tree navigation,
	// or abort). REBUILD atomically replaces the authoritative store transcript.
	needsRebuild?: boolean;
}

interface SyncResult {
	sessionId: string | null;
	path: "reuse" | "rebuild" | "clean-start";
	preserveSharedSession?: boolean;
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the live shared session.
//   REBUILD — pi's history diverged, so synthesize a complete Claude Code
//     transcript and atomically replace the SDK session store entry.
//
// The SDK materializes store entries when resuming and owns its required local
// dual-write. The bridge never computes Claude's project path or manipulates
// JSONL files. Session IDs remain stable across every rebuild; per-query writer
// revisions fence late mirror appends after aborts.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics keep their
// useful continuity.
interface SyncPlan {
	path: "reuse" | "rebuild" | "clean-start";
	priorMessages: Context["messages"];
	previousSession: SessionState | null;
	preserveSharedSession?: boolean;
	advanceCursor?: boolean;
}

interface FreshQueryRequest {
	queryCtx: QueryContext;
	syncPlan: SyncPlan;
	cwd: string;
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
	model: Model<any>;
	contextMessageCount: number;
	isReentrant: boolean;
	reusableRoot: boolean;
	spawnSignature: string;
	mcpSignature: string;
	mcpTools: Tool[];
	mcpServers: Record<string, McpServerConfig>;
	cliModel: string;
	promptMessage: SDKUserMessage;
	queryOptions: Options;
	attachAbort(): void;
}

type SessionDisposition = "rebuild" | "drop";

export const SESSION_STORE_LOAD_TIMEOUT_MS = 15_000;

export function createBridgeRuntime(dependencies: BridgeRuntimeDependencies) {
	const { providerSettings } = dependencies;
	const queryFactory = dependencies.queryFactory ?? query;

	let sharedSession: SessionState | null = null;
	const sessionStore = dependencies.sessionStore ?? new BridgeSessionStore(debug);
	let piUI: ExtensionUIContext | null = null;
	const activeQueryContexts = new Set<QueryContext>();
	// The persistent (root) query context. Each runtime owns its own, so two
	// runtimes never share query/session state through a module global.
	const rootContext = new QueryContext();

	const {
		claimCurrentPiStream,
		emitTerminalError,
		finalizeCurrentStream,
		consumeQuery,
	} = createProviderStreamRuntime({
		debug,
		notify: (message, level) => piUI?.notify(message, level),
	});

	// Convert pi messages to Anthropic API format for session import.
	// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
	// text/image/toolCall block types are handled. If all blocks in an assistant message
	// are filtered, the message is dropped — which can create invalid sequences (e.g.
	// two user messages in a row, or tool_result without preceding tool_use).
	function convertAndImportMessages(
		session: ReturnType<typeof createSession>,
		messages: Context["messages"],
		customToolNameToSdk?: Map<string, string>,
	): void {
		const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

		debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
		debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
			const c = m.content;
			if (typeof c === "string") return `[${i}]${m.role}:text`;
			if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
			return `[${i}]${m.role}:?`;
		}).join(" "));
		if (sanitizedIds.size > 0) {
			debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
				[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
		}
		// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
		const repaired = repairToolPairing(anthropicMessages);
		if (repaired.length !== anthropicMessages.length) {
			debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
		}
		if (repaired.length) session.importMessages(repaired);
	}

	// Pi doesn't pass tool results directly — it appends them to the context and calls
	// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
	// debug logging at the extraction boundary.
	function extractAllToolResults(context: Context): McpResult[] {
		const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
		debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
		debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
		for (let r = 0; r < results.length; r++) {
			debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
		}
		return results;
	}

	/** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
	function extractUserPrompt(messages: Context["messages"]): string | null {
		const last = messages[messages.length - 1];
		if (!last || last.role !== "user") return null;
		if (typeof last.content === "string") return last.content;
		return messageContentToText(last.content) || "";
	}

	/** Extract the last user message as ContentBlockParam[] (preserving images).
	 *  Returns null if no images — caller should fall back to string prompt. */
	function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
		const last = messages[messages.length - 1];
		if (!last || last.role !== "user") return null;
		if (typeof last.content === "string") {
			debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
			return null;
		}
		if (!Array.isArray(last.content)) {
			debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
			return null;
		}
		debug(`extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b: any) => b.type).join(",")}`);
		let hasImage = false;
		const blocks: ContentBlockParam[] = [];
		for (const block of last.content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				debug(`image block: mimeType=${(block as any).mimeType}, data length=${((block as any).data ?? "").length}, keys=${Object.keys(block).join(",")}`);
				if (!(block as any).data || !(block as any).mimeType) {
					debug(`image block missing data or mimeType, skipping`);
					continue;
				}
				hasImage = true;
				blocks.push({
					type: "image",
					source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
				});
			}
		}
		return hasImage ? blocks : null;
	}

	function sdkUserMessage(messages: Context["messages"]): SDKUserMessage {
		const blocks = extractUserPromptBlocks(messages);
		const text = extractUserPrompt(messages);
		if (!blocks && !text) {
			diagDump("empty_prompt", {
				contextLength: messages.length,
				lastMsgRole: messages.at(-1)?.role,
				messageRoles: messages.map((message, index) => `[${index}]${message.role}`).join(" "),
			});
		}
		return {
			type: "user",
			message: { role: "user", content: blocks ?? text ?? "[continue]" } as MessageParam,
			parent_tool_use_id: null,
			uuid: randomUUID(),
		};
	}

	/**
	 * Ensure the shared session has all messages up to (but not including) the last user message.
	 * Returns session ID to resume from, or null if no resume needed.
	 */
	function planSharedSessionSync(messages: Context["messages"], currentSession: SessionState | null = sharedSession): SyncPlan {
		const priorMessages = messages.slice(0, -1);
		if (currentSession && !currentSession.needsRebuild && priorMessages.length >= currentSession.cursor) {
			const missed = priorMessages.slice(currentSession.cursor);
			const trailingAssistantOnly = missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
			if (missed.length === 0 || trailingAssistantOnly) {
				return {
					path: "reuse",
					priorMessages,
					previousSession: currentSession,
					advanceCursor: trailingAssistantOnly,
				};
			}
		}
		if (currentSession && !currentSession.needsRebuild && priorMessages.length < currentSession.cursor) {
			return {
				path: "clean-start",
				priorMessages,
				previousSession: currentSession,
				preserveSharedSession: true,
			};
		}
		return {
			path: priorMessages.length === 0 ? "clean-start" : "rebuild",
			priorMessages,
			previousSession: currentSession,
		};
	}

	function applySharedSessionSync(
		plan: SyncPlan,
		cwd: string,
		customToolNameToSdk?: Map<string, string>,
		modelId?: string,
	): SyncResult {
		if (plan.path === "reuse") {
			const session = plan.previousSession!;
			sharedSession = plan.advanceCursor ? { ...session, cursor: plan.priorMessages.length } : session;
			debug(`Case 3: ${plan.advanceCursor ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
			return { sessionId: sharedSession.sessionId, path: "reuse" };
		}
		if (plan.path === "clean-start") {
			if (plan.preserveSharedSession) {
				const session = plan.previousSession!;
				debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${session.sessionId.slice(0, 8)}, cursor=${session.cursor}`);
				debug(`syncResult: path=clean-start preserve-shared sessionId=${session.sessionId} cursor=${session.cursor}`);
				return { sessionId: null, path: "clean-start", preserveSharedSession: true };
			}
			debug(`Case 1: clean start, ${plan.priorMessages.length + 1} total messages`);
			debug("syncResult: path=clean-start");
			return { sessionId: null, path: "clean-start" };
		}

		const previousSessionId = plan.previousSession?.sessionId;
		const previousCursor = plan.previousSession?.cursor ?? 0;
		const session = createSession({
			projectPath: cwd,
			...(previousSessionId ? { sessionId: previousSessionId } : {}),
			...(modelId ? { model: modelId } : {}),
		});
		convertAndImportMessages(session, plan.priorMessages, customToolNameToSdk);
		sessionStore.replace(session.sessionId, session.records);
		sharedSession = { sessionId: session.sessionId, cursor: plan.priorMessages.length };
		if (previousSessionId === undefined) {
			debug(`Case 2: first turn with ${plan.priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
		} else {
			const missedCount = plan.priorMessages.length - previousCursor;
			debug(`Case 4: ${missedCount} missed messages, ${plan.priorMessages.length} total → replaced session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
		}
		debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${plan.priorMessages.length} ${previousSessionId === undefined ? "first" : "preserved"}`);
		return { sessionId: session.sessionId, path: "rebuild" };
	}

	function syncSharedSession(
		messages: Context["messages"],
		cwd: string,
		customToolNameToSdk?: Map<string, string>,
		modelId?: string,
	): SyncResult {
		return applySharedSessionSync(planSharedSessionSync(messages), cwd, customToolNameToSdk, modelId);
	}

	function contextForToolResults(results: McpResult[]): QueryContext | undefined {
		for (const result of results) {
			const id = result.toolCallId;
			if (!id) continue;
			for (const queryCtx of activeQueryContexts) {
				if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
					return queryCtx;
				}
			}
		}
		return undefined;
	}

	function resolveMcpTools(context: Context): {
		mcpTools: Tool[];
		customToolNameToSdk: Map<string, string>;
		customToolNameToPi: Map<string, string>;
	} {
		const mcpTools: Tool[] = [];
		const customToolNameToSdk = new Map<string, string>();
		const customToolNameToPi = new Map<string, string>();

		if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

		for (const tool of context.tools) {
			const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
			mcpTools.push(tool);
			customToolNameToSdk.set(tool.name, sdkName);
			customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
			customToolNameToPi.set(sdkName, tool.name);
			customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
		}

		return { mcpTools, customToolNameToSdk, customToolNameToPi };
	}

	const MCP_HANDLER_EXTRA_SCHEMA = Type.Object({
		_meta: Type.Object({
			"claudecode/toolUseId": Type.String(),
		}),
	});

	function failMcpBridge(queryCtx: QueryContext): void {
		const message = "Claude bridge incompatible with this Claude Code version: CLI no longer sends claudecode/toolUseId in MCP tool metadata";
		debug(`provider: fatal MCP bridge error: ${message}`);
		piUI?.notify(message, "error");
		queryCtx.fatalError = message;
		emitTerminalError(queryCtx, "error", message);
		void closeQueryContext(queryCtx, message, "force");
	}

	function createMcpToolHandler(toolName: string, queryCtx: QueryContext) {
		return async (_args: unknown, extra: unknown): Promise<McpResult> => {
			if (!Value.Check(MCP_HANDLER_EXTRA_SCHEMA, extra)) {
				failMcpBridge(queryCtx);
				// Never return a tool result after a fatal bridge error; the closed query must remain terminal.
				return new Promise<McpResult>(() => {});
			}
			const toolCallId = extra._meta["claudecode/toolUseId"];
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${toolName} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${toolName} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				queryCtx.pendingToolCalls.set(toolCallId, { toolName, resolve });
			});
		};
	}

	// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
	// blocks on a Promise until pi delivers the matching tool result.
	function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, McpServerConfig> {
		if (!tools.length) return {};
		const mcpTools = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: jsonSchemaToZodShape(tool.parameters),
			handler: createMcpToolHandler(tool.name, queryCtx),
		}));
		const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
		return { [MCP_SERVER_NAME]: server };
	}

	function mcpSignature(tools: Tool[]): string {
		return JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
	}

	type QueryCloseMode = "drain" | "force";

	function closeQueryContext(c: QueryContext, label: string, mode: QueryCloseMode): Promise<void> {
		if (c.closeCompletion) return c.closeCompletion;
		if (!c.activeQuery && !c.inputQueue) return c.completion ?? Promise.resolve();
		debug(`provider: closing query (${label}) mode=${mode} persistent=${c.persistent}`);
		c.closing = true;
		c.abortCleanup?.();
		c.abortCleanup = null;
		c.inputQueue?.end();
		const activeQuery = c.activeQuery;
		const storeWriter = c.sessionStoreWriter;
		const localSessionFragment = c.localSessionFragment;
		if (mode === "drain") {
			debug("provider: waiting for natural query EOF before closing session-store writer");
		} else {
			storeWriter?.invalidate();
			if (sharedSession) sharedSession = { ...sharedSession, needsRebuild: true };
			try { activeQuery?.close(); } catch {}
		}
		for (const pending of c.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: "Query ended" }] });
		c.pendingToolCalls.clear();
		c.pendingResults.clear();
		c.activeQuery = null;
		c.inputQueue = null;
		c.readyForInput = false;
		activeQueryContexts.delete(c);
		const completion = c.completion ?? Promise.resolve();
		const finishClose = () => {
			storeWriter?.close();
			if (localSessionFragment) {
				deleteSession(localSessionFragment.sessionId, localSessionFragment.cwd, localSessionFragment.claudeDir);
				debug(`provider: deleted first-spawn session fragment ${localSessionFragment.sessionId.slice(0, 8)}`);
			}
			if (c.sessionStoreWriter === storeWriter) c.sessionStoreWriter = null;
			if (c.localSessionFragment === localSessionFragment) c.localSessionFragment = null;
			if (c.closeCompletion === closeCompletion) c.closeCompletion = null;
		};
		const closeCompletion = completion.then(finishClose, finishClose);
		c.closeCompletion = closeCompletion;
		return closeCompletion;
	}

	function closePersistentQuery(label: string): Promise<void> {
		const c = rootContext;
		if (!c.persistent) return Promise.resolve();
		return closeQueryContext(c, label, c.readyForInput ? "drain" : "force");
	}

	function failQuery(
		c: QueryContext,
		reason: "aborted" | "error",
		message: string,
		disposition: SessionDisposition,
	): void {
		if (disposition === "rebuild" && sharedSession) {
			sharedSession = { ...sharedSession, needsRebuild: true };
		} else if (disposition === "drop") {
			sharedSession = null;
		}
		emitTerminalError(c, reason, message);
		void closeQueryContext(c, message, "force");
	}

	function invalidResumeMaterialization(error: unknown): boolean {
		if (error instanceof MalformedSessionTranscriptError) return true;
		// SDK 0.3.219's resume materializer and Claude subprocess expose only plain Error messages.
		return /SessionStore\.(?:load|listSubkeys)\(\) timed out|No conversation found|invalid (?:resume|transcript)|malformed (?:resume|transcript)/i.test(errorMessage(error));
	}

	function invalidateStoredSession(sessionId: string, reason: string): void {
		sessionStore.delete(sessionId);
		if (sharedSession?.sessionId === sessionId) sharedSession = { ...sharedSession, needsRebuild: true };
		debug(`provider: invalidated session ${sessionId.slice(0, 8)} (${reason})`);
	}

	function settleInterruptedQuery(c: QueryContext): void {
		if (!c.turnAborted || !c.turnInterruptReceiptReceived) return;
		if (c.turnInterruptQueuedIds.length > 0) {
			failQuery(c, "aborted", "Operation aborted; Claude retained queued input, so the session will rebuild", "rebuild");
			return;
		}
		if (!c.turnResultVerdict) return;
		if (!c.turnSawAbortedAssistant && c.turnResultVerdict.type !== "interrupted") {
			failQuery(c, "aborted", "Operation aborted without complete Claude cancellation metadata; the session will rebuild", "rebuild");
			return;
		}
		c.readyForInput = c.persistent;
		c.turnAborted = false;
		c.abortCleanup?.();
		c.abortCleanup = null;
		debug("provider: interrupted query is reusable after empty receipt and terminal abort metadata");
	}

	async function spawnFreshQuery(request: FreshQueryRequest): Promise<void> {
		const {
			queryCtx, syncPlan, cwd, customToolNameToSdk, customToolNameToPi, model,
			contextMessageCount, isReentrant, reusableRoot, spawnSignature, mcpSignature,
			mcpTools, mcpServers, cliModel, promptMessage, attachAbort,
		} = request;
		try {
			if (queryCtx.closeCompletion) await queryCtx.closeCompletion;
			if (queryCtx.activeQuery) {
				await closeQueryContext(
					queryCtx,
					syncPlan.path === "reuse" ? "query options changed" : syncPlan.path,
					reusableRoot ? "drain" : "force",
				);
			}
			const syncResult = applySharedSessionSync(syncPlan, cwd, customToolNameToSdk, model.id);
			queryCtx.pendingToolCalls.clear();
			queryCtx.pendingResults.clear();
			queryCtx.persistent = !isReentrant;
			queryCtx.closing = false;
			queryCtx.spawnSignature = spawnSignature;
			queryCtx.mcpSignature = mcpSignature;
			queryCtx.hasMcpServer = mcpTools.length > 0;
			queryCtx.cliModel = cliModel;
			queryCtx.modelUsageSnapshot = {};
			const inputQueue = new PushQueue<SDKUserMessage>();
			queryCtx.inputQueue = inputQueue;
			const writerLabel = isReentrant ? "provider-child" : "provider";
			const storeWriter = sessionStore.createWriter(writerLabel);
			queryCtx.sessionStoreWriter = storeWriter;
			const queryOptions: Options = {
				...request.queryOptions,
				sessionStore: storeWriter,
				sessionStoreFlush: "batched",
				loadTimeoutMs: SESSION_STORE_LOAD_TIMEOUT_MS,
				...(mcpTools.length > 0 ? { mcpServers } : {}),
				...(syncResult.sessionId ? { resume: syncResult.sessionId } : {}),
			};
			debug("provider: fresh streaming query", `model=${cliModel} msgs=${contextMessageCount} tools=${mcpTools.length}`,
				`resume=${syncResult.sessionId?.slice(0, 8) ?? "none"} effort=${queryOptions.effort ?? "default"} persistent=${!isReentrant}`);

			const sdkQuery = queryFactory({ prompt: inputQueue, options: queryOptions });
			queryCtx.activeQuery = sdkQuery;
			activeQueryContexts.add(queryCtx);
			attachAbort();

			const completion = consumeQuery(sdkQuery, customToolNameToPi, model, queryCtx, {
				onResult(result) {
					if (queryCtx.closing) return;
					if (queryCtx.turnAborted) emitTerminalError(queryCtx, "aborted", "Operation aborted");
					else {
						queryCtx.abortCleanup?.();
						queryCtx.abortCleanup = null;
						finalizeCurrentStream(queryCtx);
					}
					const resultSessionId = result.session_id;
					const sessionId = resultSessionId ?? sharedSession?.sessionId;
					if (syncResult.preserveSharedSession && resultSessionId && resultSessionId !== sharedSession?.sessionId) {
						sessionStore.delete(resultSessionId);
						debug(`provider: deleted ephemeral reentrant session ${resultSessionId.slice(0, 8)}`);
					} else if (!syncResult.preserveSharedSession && sessionId) {
						sharedSession = { sessionId, cursor: queryCtx.latestCursor };
						debug(`provider: turn complete, session=${sessionId.slice(0, 8)}, cursor=${queryCtx.latestCursor}, storedRecords=${sessionStore.entryCount(sessionId)}`);
					}
					const verdict = queryCtx.turnResultVerdict;
					if (!verdict) {
						failQuery(queryCtx, "error", "Claude result was not classified", "rebuild");
					} else if (queryCtx.turnAborted) {
						settleInterruptedQuery(queryCtx);
					} else if (verdict.type === "interrupted") {
						failQuery(queryCtx, "aborted", "Claude aborted the turn without an interrupt receipt; the session will rebuild", "rebuild");
					} else if (verdict.type === "reusable") {
						queryCtx.readyForInput = queryCtx.persistent;
					} else {
						queryCtx.readyForInput = false;
						void closeQueryContext(queryCtx, `terminal result ${result.terminal_reason ?? result.subtype}`, "drain");
					}
					if (!queryCtx.persistent) void closeQueryContext(queryCtx, "reentrant turn complete", "drain");
				},
				onSessionId(sessionId) {
					if (queryCtx.closing) {
						if (!syncResult.sessionId) deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
						return;
					}
					if (!syncResult.sessionId && !queryCtx.localSessionFragment) {
						queryCtx.localSessionFragment = {
							sessionId,
							cwd,
							...(process.env.CLAUDE_CONFIG_DIR ? { claudeDir: process.env.CLAUDE_CONFIG_DIR } : {}),
						};
					}
					if (!syncResult.preserveSharedSession) sharedSession = { sessionId, cursor: queryCtx.latestCursor };
				},
				onMirrorError(message) {
					invalidateStoredSession(message.key.sessionId, `mirror_error: ${message.error}`);
					piUI?.notify(`Claude transcript mirror failed: ${message.error}`, "error");
					if (!queryCtx.closing) failQuery(queryCtx, "error", `Claude transcript mirror failed: ${message.error}`, "rebuild");
				},
			});
			queryCtx.completion = completion;
			void completion.then(() => {
				debug(`consumeQuery: query exited, closing=${queryCtx.closing} persistent=${queryCtx.persistent}`);
				if (!queryCtx.closing && queryCtx.activeQuery === sdkQuery) {
					failQuery(queryCtx, queryCtx.turnAborted ? "aborted" : "error", queryCtx.turnAborted ? "Operation aborted" : "Claude Code query ended unexpectedly", queryCtx.turnAborted ? "rebuild" : "drop");
				}
			}).catch((error) => {
				debug("provider: query consumer error", error);
				if (!queryCtx.closing) {
					const invalidResume = Boolean(syncResult.sessionId && !queryCtx.turnResultVerdict && invalidResumeMaterialization(error));
					if (syncResult.sessionId && invalidResume) invalidateStoredSession(syncResult.sessionId, errorMessage(error));
					failQuery(queryCtx, queryCtx.turnAborted ? "aborted" : "error", queryCtx.turnAborted ? "Operation aborted" : errorMessage(error), queryCtx.turnAborted || invalidResume ? "rebuild" : "drop");
				}
			});
			await awaitQueryInitialization(sdkQuery);
			if (!queryCtx.closing) {
				inputQueue.push(promptMessage);
				if (isReentrant) inputQueue.end();
			}
		} catch (error) {
			if (sharedSession && invalidResumeMaterialization(error)) invalidateStoredSession(sharedSession.sessionId, errorMessage(error));
			failQuery(queryCtx, "error", errorMessage(error), sharedSession ? "rebuild" : "drop");
		}
	}

	/** Provider entry point. Pi calls this for each new prompt and each tool result. */
	function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();
		const root = rootContext;
		const lastMsg = context.messages[context.messages.length - 1];
		const lastMsgRole = lastMsg?.role;
		debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!root.activeQuery}, ready=${root.readyForInput}, lastMsgRole=${lastMsgRole}`);

		const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
		const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;

		if (resultCtx) {
			claimCurrentPiStream(stream, "tool-result", resultCtx);
			if (resultCtx.fatalError) {
				emitTerminalError(resultCtx, "error", resultCtx.fatalError);
				return stream;
			}
			resultCtx.activeModel = model;
			resultCtx.resetTurnState(model);
			resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
			debug(`provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);

			if (lastMsgRole === "user") {
				if (resultCtx.persistent && resultCtx.inputQueue) {
					resultCtx.inputQueue.push(sdkUserMessage(context.messages));
					debug(`provider: queued native steering message: ${extractUserPrompt(context.messages)?.slice(0, 60) ?? "[image]"}`);
				} else {
					debug("provider: ignored steering for one-shot reentrant query");
				}
			}

			for (const result of allResults) {
				const id = result.toolCallId;
				if (id && resultCtx.pendingToolCalls.has(id)) {
					const pending = resultCtx.pendingToolCalls.get(id)!;
					resultCtx.pendingToolCalls.delete(id);
					debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
					pending.resolve(result);
				} else if (id) {
					resultCtx.pendingResults.set(id, result);
					debug(`provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`);
				} else {
					debug("WARNING: tool result without toolCallId, cannot match");
				}
			}
			if (resultCtx.pendingToolCalls.size > 0) {
				debug(`WARNING: ${resultCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
				piUI?.notify(`Claude bridge: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
			}
			if (sharedSession) sharedSession.cursor = context.messages.length;
			return stream;
		}

		if (lastMsgRole === "toolResult") {
			debug("provider: orphaned tool result after abort, emitting end_turn");
			if (sharedSession) sharedSession.cursor = context.messages.length;
			claimCurrentPiStream(stream, "orphan-tool-result", root);
			if (root.fatalError) {
				emitTerminalError(root, "error", root.fatalError);
				return stream;
			}
			queueMicrotask(() => {
				root.resetTurnState(model);
				finalizeCurrentStream(root);
			});
			return stream;
		}

		const reusableRoot = Boolean(root.activeQuery && root.persistent && root.readyForInput);
		const isReentrant = Boolean(root.activeQuery && !reusableRoot);
		const queryCtx = isReentrant ? new QueryContext() : root;
		const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const syncPlan = planSharedSessionSync(context.messages);
		const promptMessage = sdkUserMessage(context.messages);

		const systemPromptMode = providerSettings.systemPromptMode;
		const systemPrompt = buildClaudeSystemPrompt(context.systemPrompt, systemPromptMode, providerSettings.systemPromptReplacements);
		const settingSources = settingSourcesFor(systemPromptMode);
		const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
		const effort = resolveThinkingEffort(model, options?.reasoning);
		const cliModel = claudeCodeModelId(model);
		const extraArgs: Record<string, string | null> = {};
		if (effort) extraArgs["thinking-display"] = "summarized";
		const spawnSignature = JSON.stringify({
			cwd, systemPrompt, effort: effort ?? null, settingSources: settingSources ?? null,
			claudeExecutable: claudeExecutable ?? null,
		});
		const nextMcpSignature = mcpSignature(mcpTools);
		const mcpServers = buildMcpServers(mcpTools, queryCtx);

		const canPush = Boolean(
			!isReentrant && queryCtx.activeQuery && queryCtx.persistent && queryCtx.readyForInput &&
			syncPlan.path === "reuse" && queryCtx.spawnSignature === spawnSignature,
		);

		claimCurrentPiStream(stream, canPush ? "persistent-reuse" : "fresh-query", queryCtx);
		queryCtx.activeModel = model;
		queryCtx.beginCommand(model);
		queryCtx.latestCursor = Math.max(queryCtx.latestCursor, context.messages.length);
		queryCtx.fatalError = null;

		const attachAbort = () => {
			queryCtx.abortCleanup?.();
			if (!options?.signal) return;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				queryCtx.turnAborted = true;
				queryCtx.readyForInput = false;
				for (const pending of queryCtx.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] });
				queryCtx.pendingToolCalls.clear();
				const activeQuery = queryCtx.activeQuery;
				if (!activeQuery) {
					failQuery(queryCtx, "aborted", "Operation aborted", "rebuild");
					return;
				}
				void activeQuery.interrupt().then((receipt) => {
					if (!queryCtx.turnAborted || queryCtx.closing) return;
					queryCtx.turnInterruptReceiptReceived = true;
					queryCtx.turnInterruptQueuedIds = receipt?.still_queued ?? ["unverified-queued-input"];
					debug(`provider: interrupt receipt queued=${queryCtx.turnInterruptQueuedIds.length}`);
					settleInterruptedQuery(queryCtx);
				}).catch((error) => {
					debug("provider: graceful interrupt failed", error);
					failQuery(queryCtx, "aborted", "Operation aborted", "rebuild");
				});
				killTimer = setTimeout(() => {
					if (!queryCtx.turnAborted || queryCtx.readyForInput) return;
					debug("provider: interrupt timed out; forcing query close");
					failQuery(queryCtx, "aborted", "Operation aborted", "rebuild");
				}, 5000);
			};
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
			queryCtx.abortCleanup = () => {
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", onAbort);
			};
		};

		if (canPush) {
			applySharedSessionSync(syncPlan, cwd, customToolNameToSdk, model.id);
			attachAbort();
			void (async () => {
				try {
					if (queryCtx.mcpSignature !== nextMcpSignature) {
						debug(`provider: reconciling MCP tools without process replacement (${queryCtx.hasMcpServer ? "replace/remove" : "add"})`);
						await reconcileMcpServers(queryCtx.activeQuery!, MCP_SERVER_NAME, queryCtx.hasMcpServer, mcpServers);
						queryCtx.mcpSignature = nextMcpSignature;
						queryCtx.hasMcpServer = mcpTools.length > 0;
					}
					if (queryCtx.cliModel !== cliModel) {
						debug(`provider: persistent setModel ${queryCtx.cliModel} → ${cliModel}`);
						await queryCtx.activeQuery!.setModel(cliModel);
						queryCtx.cliModel = cliModel;
					}
					queryCtx.inputQueue!.push(promptMessage);
					debug(`Case 3: pushed turn into persistent session ${sharedSession?.sessionId.slice(0, 8) ?? "unknown"}`);
				} catch (error) {
					if (!queryCtx.closing) failQuery(queryCtx, "error", errorMessage(error), "rebuild");
				}
			})();
			return stream;
		}

		const queryOptions: Options = {
			cwd,
			env: sdkChildEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" }),
			tools: [], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
			includePartialMessages: true, strictMcpConfig: true, systemPrompt, model: cliModel, extraArgs,
			...(effort ? { effort } : {}), ...(settingSources ? { settingSources } : {}),
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			...makeCliDebugOptions(isReentrant ? "provider-child" : "provider"),
		};
		void spawnFreshQuery({
			queryCtx,
			syncPlan,
			cwd,
			customToolNameToSdk,
			customToolNameToPi,
			model,
			contextMessageCount: context.messages.length,
			isReentrant,
			reusableRoot,
			spawnSignature,
			mcpSignature: nextMcpSignature,
			mcpTools,
			mcpServers,
			cliModel,
			promptMessage,
			queryOptions,
			attachAbort,
		});
		return stream;
	}

	// Full session reset for pi lifecycle events (session start/shutdown). Closes any
	// persistent query and drops the shared session + store. The caller (index.ts)
	// owns the provider-registration global and clears it separately.
	async function clear(reason: string): Promise<void> {
		debug(`${reason}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
		const contexts = [...activeQueryContexts];
		await Promise.all(contexts.map((context) => closeQueryContext(
			context,
			reason,
			context.readyForInput ? "drain" : "force",
		)));
		sharedSession = null;
		sessionStore.clear();
	}

	// Provider switch: close the persistent query but keep the shared session/store.
	function closePersistent(reason: string): Promise<void> {
		return closePersistentQuery(reason);
	}

	// pi /compact and session-tree navigation (rewind / fork-at-point / branch
	// switch) both mutate pi's messages array out from under the bridge.
	// syncSharedSession's REUSE check would otherwise keep --resume'ing a CC
	// session that no longer matches pi's history. Force the next call down the
	// REBUILD path so CC sees the current history.
	async function markRebuild(reason: string): Promise<void> {
		if (sharedSession) {
			debug(`${reason}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
			await closePersistentQuery(reason);
			sharedSession = { ...sharedSession, needsRebuild: true };
		}
	}

	function setUI(ui: ExtensionUIContext | null): void {
		piUI = ui;
	}

	return {
		stream: streamClaudeAgentSdk,
		clear,
		closePersistent,
		markRebuild,
		setUI,
		// @internal — surface for tests that exercise session sync and MCP routing
		// by instantiating the factory directly (no extension activation).
		test: {
			rootContext,
			resetSharedSession() {
				sharedSession = null;
				sessionStore.clear();
			},
			setSharedSession(state: SessionState | null) {
				sharedSession = state;
			},
			getSharedSession() {
				return sharedSession;
			},
			getStoredSession(sessionId: string) {
				return sessionStore.load(sessionId);
			},
			planSharedSessionSync,
			applySharedSessionSync,
			syncSharedSession,
			consumeQuery,
			finalizeCurrentStream,
			closeQueryContext,
			settleInterruptedQuery,
			createMcpToolHandler,
			streamClaudeAgentSdk,
		},
	};
}
