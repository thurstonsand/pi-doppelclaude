import { createAssistantMessageEventStream, StringEnum, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { buildSessionContext, compact, keyHint, type CompactionEntry, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createSdkMcpServer, query, type SDKMessage, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { Text } from "@earendil-works/pi-tui";
import { createSession, repairToolPairing } from "cc-session-io";
import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages, mapSdkToolNameToPi as mapToolName } from "./convert.js";
import { applyLongContext, buildModels, claudeCodeModelId, type LongContextSettings, resolveModel as _resolveModel, resolveThinkingEffort } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { PushQueue, QueryContext, ctx } from "./query-state.js";
import { loadConfig, type Config } from "./config.js";
import { jsonSchemaToZodShape } from "./typebox-to-zod.js";
import { buildActionSummary, type ToolCallState } from "./askclaude-ui.js";
import { buildClaudeSystemPrompt } from "./system-prompt.js";
import { createProviderStreamRuntime, resultErrorText } from "./provider.js";
import { BridgeSessionStore } from "./session-store.js";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
const DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "claude-bridge-diag.log");

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	appendFileSync(DIAG_LOG_PATH, JSON.stringify(entry) + "\n");
	debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// --- Constants ---

// Global key to prevent re-registration of the provider across module reloads.
//
// Nested sessions can load this module again after their ModelRuntime has copied
// the parent's provider registration. Re-registering with the child module's
// `streamSimple` would replace the propagated parent function and break tool
// result delivery because the child function has different module state.
//
// By storing the active streamSimple in a Symbol.for() global (shared across all
// module instances), we ensure only the first module instance registers.
//
// On session_shutdown (including /reload), clearSession() resets this so a fresh
// registration can occur for the next session.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");
const BRIDGE_CLIENT_APP = "pi-claude-bridge/0.6.2";

// Project Pi's public Anthropic catalog down to bridge provider metadata.
const MODELS = buildModels(getBuiltinModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
// TODO(phase 2): derive plan and served context windows from live-query accountInfo/modelUsage.
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

function resolveModel(input: string) {
	return _resolveModel(MODELS, input);
}

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// AskClaude mode presets — controls which CC tools are blocked per mode.
// Only block tools that can't work (no pi TUI for user interaction).
// Other CC tools (Agent, SendMessage, RemoteTrigger, Tasks, etc.) are intentionally not blocked.
const ASKCLAUDE_ALWAYS_BLOCKED = [
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ToolSearch", // probes for blocked tools, wastes tokens
	"ScheduleWakeup", // no harness to fire wakeup from inside a delegated subagent
];
const MODE_DISALLOWED_TOOLS: Record<string, string[]> = {
	full: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
	],
	read: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Write", "Edit", "Bash", "NotebookEdit",
		"EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	],
	none: [
		...ASKCLAUDE_ALWAYS_BLOCKED,
		"Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent",
		"NotebookEdit", "EnterWorktree", "ExitWorktree",
		"CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
		"WebFetch", "WebSearch",
	],
};

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	// Force the next syncSharedSession call down the REBUILD path when pi has
	// mutated its messages array out from under us (compact, tree navigation,
	// or abort). REBUILD atomically replaces the authoritative store transcript.
	needsRebuild?: boolean;
}

let sharedSession: SessionState | null = null;
const sessionStore = new BridgeSessionStore(debug);

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
	};
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

function settingSourcesFor(systemPromptMode: string): SettingSource[] | undefined {
	return systemPromptMode === "pi" ? [] : undefined;
}

function sdkChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		CLAUDE_AGENT_SDK_CLIENT_APP: BRIDGE_CLIENT_APP,
		...extra,
	};
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		const promptText = extractIsolatedSummaryPrompt(context.messages);
		const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
		const compactProviderSettings = loadConfig(cwd).provider ?? {};
		const compactSystemPromptMode = compactProviderSettings.systemPromptMode ?? "append";
		const compactSettingSources = settingSourcesFor(compactSystemPromptMode);
		const claudeExecutable = compactProviderSettings.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`);

		sdkQuery = query({
			prompt: promptText,
			options: {
				cwd,
				env: sdkChildEnv({ DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }),
				tools: [],
				strictMcpConfig: true,
				...(compactSettingSources ? { settingSources: compactSettingSources } : {}),
				skills: [],
				persistSession: false,
				systemPrompt: buildClaudeSystemPrompt(
					context.systemPrompt,
					compactSystemPromptMode,
					compactProviderSettings.systemPromptReplacements,
				),
				model: cliModel,
				maxTurns: 1,
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				if (message.subtype === "success") {
					finalText = message.result || assistantText;
				} else {
					errorText = resultErrorText(message);
				}
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

function reinjectPriorCompactionFileOps(branchEntries: Array<{ type: string; details?: unknown }>, preparation: { fileOps: { read: Set<string>; edited: Set<string> } }): void {
	const prior = [...branchEntries]
		.reverse()
		.find((entry): entry is CompactionEntry => entry.type === "compaction");
	const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
	if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
	for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
	for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
	debug(`compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`);
}

interface SyncResult {
	sessionId: string | null;
	path: "reuse" | "rebuild" | "clean-start";
	preserveSharedSession?: boolean;
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
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

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
const activeQueryContexts = new Set<QueryContext>();

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

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
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
	try { queryCtx.activeQuery?.close(); } catch {}
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
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createSdkMcpServer>> | undefined {
	if (!tools.length) return undefined;
	const mcpTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: jsonSchemaToZodShape(tool.parameters),
		handler: createMcpToolHandler(tool.name, queryCtx),
	}));
	const server = createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools: mcpTools });
	return { [MCP_SERVER_NAME]: server };
}

const {
	claimCurrentPiStream,
	emitTerminalError,
	finalizeCurrentStream,
	consumeQuery,
	logServedContextWindow,
} = createProviderStreamRuntime({
	debug,
	notify: (message, level) => piUI?.notify(message, level),
});

// @internal
export const __test = {
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
	createMcpToolHandler,
	streamClaudeAgentSdk,
};

function closeQueryContext(c: QueryContext, label: string, inputWasReady = c.readyForInput): Promise<void> {
	if (c.closeCompletion) return c.closeCompletion;
	if (!c.activeQuery && !c.inputQueue) return c.completion ?? Promise.resolve();
	debug(`provider: closing query (${label}) persistent=${c.persistent}`);
	c.closing = true;
	c.abortCleanup?.();
	c.abortCleanup = null;
	const drainNaturally = inputWasReady && c.inputQueue !== null;
	c.inputQueue?.end();
	const storeWriter = c.sessionStoreWriter;
	if (drainNaturally) {
		debug("provider: waiting for natural query EOF before closing session-store writer");
	} else {
		try { c.activeQuery?.close(); } catch {}
	}
	for (const pending of c.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: "Query ended" }] });
	c.pendingToolCalls.clear();
	c.pendingResults.clear();
	c.activeQuery = null;
	c.inputQueue = null;
	c.readyForInput = false;
	activeQueryContexts.delete(c);
	const completion = c.completion ?? Promise.resolve();
	const closeCompletion = completion.finally(() => {
		storeWriter?.close();
		if (c.sessionStoreWriter === storeWriter) c.sessionStoreWriter = null;
		if (c.closeCompletion === closeCompletion) c.closeCompletion = null;
	});
	c.closeCompletion = closeCompletion;
	return closeCompletion;
}

function closePersistentQuery(label: string): Promise<void> {
	const c = ctx();
	return c.persistent ? closeQueryContext(c, label) : Promise.resolve();
}

type SessionDisposition = "rebuild" | "drop";

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
	void closeQueryContext(c, message);
}

/** Provider entry point. Pi calls this for each new prompt and each tool result. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const root = ctx();
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
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context, askClaudeToolName);
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
	const syncPlan = planSharedSessionSync(context.messages);
	const promptMessage = sdkUserMessage(context.messages);

	const systemPromptMode = providerSettings.systemPromptMode ?? "append";
	const systemPrompt = buildClaudeSystemPrompt(context.systemPrompt, systemPromptMode, providerSettings.systemPromptReplacements);
	const settingSources = settingSourcesFor(systemPromptMode);
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
	const effort = resolveThinkingEffort(model, options?.reasoning);
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const extraArgs: Record<string, string | null> = {};
	if (effort) extraArgs["thinking-display"] = "summarized";
	const spawnSignature = JSON.stringify({
		cwd, systemPrompt, effort: effort ?? null, settingSources: settingSources ?? null,
		claudeExecutable: claudeExecutable ?? null,
		tools: mcpTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
	});

	const canPush = Boolean(
		!isReentrant && queryCtx.activeQuery && queryCtx.persistent && queryCtx.readyForInput &&
		syncPlan.path === "reuse" && queryCtx.spawnSignature === spawnSignature,
	);

	claimCurrentPiStream(stream, canPush ? "persistent-reuse" : "fresh-query", queryCtx);
	queryCtx.activeModel = model;
	queryCtx.resetTurnState(model);
	queryCtx.latestCursor = Math.max(queryCtx.latestCursor, context.messages.length);
	queryCtx.fatalError = null;

	const attachAbort = () => {
		queryCtx.abortCleanup?.();
		queryCtx.turnAborted = false;
		if (!options?.signal) return;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			queryCtx.turnAborted = true;
			for (const pending of queryCtx.pendingToolCalls.values()) pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] });
			queryCtx.pendingToolCalls.clear();
			void queryCtx.activeQuery?.interrupt().catch((error) => {
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
				if (queryCtx.cliModel !== cliModel) {
					debug(`provider: persistent setModel ${queryCtx.cliModel} → ${cliModel}`);
					await queryCtx.activeQuery!.setModel(cliModel);
					queryCtx.cliModel = cliModel;
				}
				queryCtx.inputQueue!.push(promptMessage);
				debug(`Case 3: pushed turn into persistent session ${sharedSession?.sessionId.slice(0, 8) ?? "unknown"}`);
			} catch (error) {
				failQuery(queryCtx, "error", errorMessage(error), "drop");
			}
		})();
		return stream;
	}

	void (async () => {
		try {
			if (queryCtx.activeQuery) await closeQueryContext(queryCtx, syncPlan.path === "reuse" ? "query options changed" : syncPlan.path, reusableRoot);
			const syncResult = applySharedSessionSync(syncPlan, cwd, customToolNameToSdk, model.id);
			queryCtx.pendingToolCalls.clear();
			queryCtx.pendingResults.clear();
			queryCtx.persistent = !isReentrant;
			queryCtx.closing = false;
			queryCtx.spawnSignature = spawnSignature;
			queryCtx.cliModel = cliModel;
			const inputQueue = new PushQueue<SDKUserMessage>();
			queryCtx.inputQueue = inputQueue;
			inputQueue.push(promptMessage);
			if (isReentrant) inputQueue.end();

			const mcpServers = buildMcpServers(mcpTools, queryCtx);
			const writerLabel = isReentrant ? "provider-child" : "provider";
			const storeWriter = sessionStore.createWriter(writerLabel);
			queryCtx.sessionStoreWriter = storeWriter;
			const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
				cwd,
				env: sdkChildEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" }),
				tools: [], permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true,
				includePartialMessages: true, strictMcpConfig: true, systemPrompt, model: cliModel, extraArgs,
				sessionStore: storeWriter,
				...(effort ? { effort } : {}), ...(settingSources ? { settingSources } : {}),
				...(mcpServers ? { mcpServers } : {}), ...(syncResult.sessionId ? { resume: syncResult.sessionId } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions(isReentrant ? "provider-child" : "provider"),
			};
			debug("provider: fresh streaming query", `model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
				`resume=${syncResult.sessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"} persistent=${!isReentrant}`);

			const sdkQuery = query({ prompt: inputQueue, options: queryOptions });
			queryCtx.activeQuery = sdkQuery;
			activeQueryContexts.add(queryCtx);
			attachAbort();

			queryCtx.completion = consumeQuery(sdkQuery, customToolNameToPi, model, queryCtx, {
				onResult(result) {
					queryCtx.abortCleanup?.();
					queryCtx.abortCleanup = null;
					if (queryCtx.turnAborted) emitTerminalError(queryCtx, "aborted", "Operation aborted");
					else finalizeCurrentStream(queryCtx);
					queryCtx.readyForInput = queryCtx.persistent;
					queryCtx.turnAborted = false;
					const resultSessionId = (result as { session_id?: string }).session_id;
					const sessionId = resultSessionId ?? sharedSession?.sessionId;
					if (syncResult.preserveSharedSession && resultSessionId && resultSessionId !== sharedSession?.sessionId) {
						sessionStore.delete(resultSessionId);
						debug(`provider: deleted ephemeral reentrant session ${resultSessionId.slice(0, 8)}`);
					} else if (!syncResult.preserveSharedSession && sessionId) {
						sharedSession = { sessionId, cursor: queryCtx.latestCursor };
						debug(`provider: turn complete, session=${sessionId.slice(0, 8)}, cursor=${queryCtx.latestCursor}, storedRecords=${sessionStore.entryCount(sessionId)}`);
					}
					if (!queryCtx.persistent) void closeQueryContext(queryCtx, "reentrant turn complete");
				},
				onSessionId(sessionId) {
					if (!syncResult.preserveSharedSession) sharedSession = { sessionId, cursor: queryCtx.latestCursor };
				},
			}).then(() => {
				debug(`consumeQuery: query exited, closing=${queryCtx.closing} persistent=${queryCtx.persistent}`);
				if (!queryCtx.closing && queryCtx.activeQuery === sdkQuery) {
					failQuery(queryCtx, queryCtx.turnAborted ? "aborted" : "error", queryCtx.turnAborted ? "Operation aborted" : "Claude Code query ended unexpectedly", queryCtx.turnAborted ? "rebuild" : "drop");
				}
			}).catch((error) => {
				debug("provider: query consumer error", error);
				if (!queryCtx.closing) {
					failQuery(queryCtx, queryCtx.turnAborted ? "aborted" : "error", queryCtx.turnAborted ? "Operation aborted" : errorMessage(error), queryCtx.turnAborted ? "rebuild" : "drop");
				}
			});
		} catch (error) {
			failQuery(queryCtx, "error", errorMessage(error), "drop");
		}
	})();
	return stream;
}

// --- AskClaude: prompt and wait ---

async function promptAndWait(
	prompt: string,
	mode: "full" | "read" | "none",
	toolCalls: Map<string, ToolCallState>,
	signal?: AbortSignal,
	options?: {
		systemPrompt?: string;
		onStreamUpdate?: (responseText: string) => void;
		model?: string;
		thinking?: string;
		isolated?: boolean;
		context?: Context["messages"];
	},
): Promise<{ responseText: string; stopReason: string }> {
	const cwd = process.cwd();
	const requestedModel = options?.model ?? "opus";
	const model = resolveModel(requestedModel);
	const modelId = model?.id ?? requestedModel;
	const cliModel = model ? claudeCodeModelId(model, longContextSettings) : modelId;

	// Session resume for shared mode — reuse provider's session if it exists,
	// otherwise create one from pi's context.
	// Note: doesn't update sharedSession.cursor after completion, so the next
	// provider call will see missed messages and trigger a Case 4 rebuild.
	let resumeSessionId: string | null = null;
	if (!options?.isolated && options?.context?.length) {
		if (sharedSession) {
			// Provider already has a session — just resume from it
			// Any missed messages from other providers were already handled by the provider's Case 4
			resumeSessionId = sharedSession.sessionId;
		} else {
			// No provider session yet — create one from pi's context
			const contextWithPrompt = [...options.context, { role: "user" as const, content: prompt, timestamp: Date.now() }];
			const sync = syncSharedSession(contextWithPrompt as Context["messages"], cwd, undefined, modelId);
			resumeSessionId = sync.sessionId;
		}
	}

	// Mode → disallowed tools
	const disallowedTools = MODE_DISALLOWED_TOOLS[mode] ?? [];

	const systemPromptMode = providerSettings.systemPromptMode ?? "append";
	const systemPrompt = options?.systemPrompt
		? buildClaudeSystemPrompt(
			options.systemPrompt,
			systemPromptMode,
			providerSettings.systemPromptReplacements,
		)
		: undefined;
	const settingSources = settingSourcesFor(systemPromptMode);

	const effort = resolveThinkingEffort(model, options?.thinking);

	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const extraArgs: Record<string, string | null> = { model: cliModel };
	if (effort) extraArgs["thinking-display"] = "summarized";

	debug("askClaude:",
		`mode=${mode} model=${modelId} cliModel=${cliModel} effort=${effort ?? "default"}`,
		`isolated=${options?.isolated ?? false} resume=${resumeSessionId?.slice(0, 8) ?? "none"}`,
		`systemPromptMode=${systemPromptMode} promptLen=${prompt.length}`);

	const storeWriter = options?.isolated ? null : sessionStore.createWriter("askclaude");
	let sdkQuery: ReturnType<typeof query>;
	try {
		sdkQuery = query({
			prompt,
			options: {
				cwd,
				env: sdkChildEnv({ ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" }),
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				strictMcpConfig: true,
				...(storeWriter ? { sessionStore: storeWriter } : {}),
				...(disallowedTools.length ? { disallowedTools } : {}),
				...(effort ? { effort } : {}),
				...(systemPrompt ? { systemPrompt } : {}),
				...(settingSources ? { settingSources } : {}),
				extraArgs,
				...(resumeSessionId ? { resume: resumeSessionId } : {}),
				...(options?.isolated ? { persistSession: false } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("askclaude"),
			},
		});
	} catch (error) {
		storeWriter?.close();
		throw error;
	}

	// Abort handling
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		sdkQuery.interrupt().catch(() => { try { sdkQuery.close(); } catch {} });
	};
	if (signal?.aborted) {
		onAbort();
		sdkQuery.close();
		storeWriter?.close();
		throw new Error("Aborted");
	}
	signal?.addEventListener("abort", onAbort, { once: true });

	let responseText = "";
	let sdkMessageCount = 0;
	let textDeltaCount = 0;
	let resultSubtype: string | undefined;
	let resultError: string | undefined;

	try {
		for await (const message of sdkQuery) {
			if (wasAborted) break;
			sdkMessageCount++;

			switch (message.type) {
				case "stream_event": {
					const event = (message as SDKMessage & { event: any }).event;
					// Text deltas → accumulate and stream
					if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
						responseText += event.delta.text;
						textDeltaCount++;
						options?.onStreamUpdate?.(responseText);
					}
					// Tool call start → track for action summary progress
					if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
						debug(`askClaude: tool_use start: ${event.content_block.name}`);
						toolCalls.set(event.content_block.id, {
							name: mapToolName(event.content_block.name),
							status: "running",
						});
					}
					break;
				}
				case "assistant": {
					// Update tool calls with full input for action summary
					for (const block of (message as any).message?.content ?? []) {
						if (block.type === "tool_use") {
							toolCalls.set(block.id, {
								name: mapToolName(block.name),
								status: "complete",
								rawInput: block.input,
							});
						}
					}
					break;
				}
				case "result": {
					resultSubtype = message.subtype;
					if (message.subtype !== "success") resultError = resultErrorText(message);
					const r = message as any;
					if (r.usage) {
						debug(`askClaude: result usage: in=${r.usage.input_tokens} out=${r.usage.output_tokens} cacheRead=${r.usage.cache_read_input_tokens ?? 0} cacheWrite=${r.usage.cache_creation_input_tokens ?? 0} turns=${r.num_turns ?? "?"}`);
					}
					if (!responseText && message.subtype === "success" && message.result) {
						responseText = message.result;
					}
					break;
				}
			}
		}

		if (resultError) throw new Error(resultError);
		const stopReason = wasAborted ? "cancelled" : "stop";
		debug(`askClaude: done`,
			`stopReason=${stopReason} resultSubtype=${resultSubtype ?? "none"}`,
			`sdkMessages=${sdkMessageCount} textDeltas=${textDeltaCount} responseLen=${responseText.length}`,
			`toolCalls=${toolCalls.size}`);
		return { responseText, stopReason };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		sdkQuery.close();
		storeWriter?.close();
	}
}

// --- Extension registration ---

const DEFAULT_TOOL_DESCRIPTION_FULL = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself.";
const DEFAULT_TOOL_DESCRIPTION = "Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories). Read-only — Claude Code can explore the codebase but not make changes. Prefer to handle straightforward tasks yourself.";

const PREVIEW_MAX_CHARS = 1000;
const PREVIEW_MAX_LINES = 6;

const askClaudeToolName = "AskClaude";

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
	};
	const registeredModels = applyLongContext(MODELS, longContextSettings);

	// Reset shared session on pi session lifecycle events
	const clearSession = async (event: string) => {
		debug(`${event}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
		await closePersistentQuery(event);
		sharedSession = null;
		sessionStore.clear();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", async (event, ctx) => {
		piUI = ctx.ui;
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			await clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_shutdown", () => clearSession("session_shutdown"));
	pi.on("model_select", async (event) => {
		if (event.previousModel?.baseUrl === "claude-bridge" && event.model.baseUrl !== "claude-bridge") {
			await closePersistentQuery("provider switch");
		}
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation,
				ctx.model,
				undefined,
				undefined,
				event.customInstructions,
				event.signal,
				undefined,
				isolatedStreamFn,
				undefined,
			);
			debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
			return { compaction };
		} catch (err) {
			const msg = errorMessage(err);
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history.
	const markRebuild = async (event: string) => {
		if (sharedSession) {
			debug(`${event}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
			await closePersistentQuery(event);
			sharedSession = { ...sharedSession, needsRebuild: true };
		}
	};
	pi.on("session_compact", (event) => markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => markRebuild("session_tree"));

	// --- Provider ---
	//
	// Guard against re-registration when the module is loaded multiple times.
	// A nested runtime receives the parent's provider registration before loading
	// this module; replacing its streamSimple would break tool-result delivery.
	// See ACTIVE_STREAM_SIMPLE_KEY for the full mechanism.

	const g = globalThis as Record<symbol, any>;
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: registeredModels,
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamClaudeAgentSdk as any,
		});
	} else {
		// Subsequent instance: retain the provider registration propagated into
		// the nested runtime. Calls route through the parent's streamSimple and
		// its reentrant QueryContexts.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}

	// --- AskClaude tool ---

	const askConf = config.askClaude;
	const allowFull = askConf?.allowFullMode !== false;
	const defaultMode = askConf?.defaultMode ?? "read";

	const modeValues = allowFull ? ["read", "full", "none"] as const : ["read", "none"] as const;
	let modeDesc = `"read" (default): questions about the codebase — review, analysis, explain. "none": general knowledge only (no file access).`;
	if (allowFull) modeDesc += ` "full": allows writing and bash execution (careful: runs without feedback to pi).`;

	if (askConf?.enabled !== false) {
		const askClaudeParams = Type.Object({
			prompt: Type.String({ description: "The question or task for Claude Code. By default Claude sees the full conversation history. Don't research up front, let Claude explore." }),
			mode: Type.Optional(StringEnum(modeValues, { description: modeDesc })),
			model: Type.Optional(Type.String({ description: 'Claude model (e.g. "opus", "sonnet", "haiku", or full ID). Defaults to "opus".' })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Thinking effort level. Omit to use Claude Code's default." })),
			isolated: Type.Optional(Type.Boolean({ description: "When true, Claude sees only this prompt (clean session). When false (default), Claude sees the full conversation history." })),
		});
		pi.registerTool<typeof askClaudeParams>({
			name: "AskClaude",
			label: "Ask Claude Code",
			description: askConf?.description ?? (allowFull ? DEFAULT_TOOL_DESCRIPTION_FULL : DEFAULT_TOOL_DESCRIPTION),
			parameters: askClaudeParams,
			renderCall(args, theme) {
				let text = theme.fg("mdLink", theme.bold("AskClaude "));
				const mode = args.mode ?? defaultMode;
				const tags: string[] = [];
				if (mode !== defaultMode) tags.push(`mode=${mode}`);
				if (args.model) tags.push(`model=${args.model}`);
				if (args.thinking) tags.push(`thinking=${args.thinking}`);
				if (args.isolated) tags.push("isolated");
				if (tags.length) text += `${theme.fg("accent", `[${tags.join(", ")}]`)} `;
				const truncated = args.prompt.length > PREVIEW_MAX_CHARS ? args.prompt.substring(0, PREVIEW_MAX_CHARS) : args.prompt;
				const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
				text += theme.fg("muted", `"${lines.join("\n")}"`);
				if (args.prompt.length > PREVIEW_MAX_CHARS || args.prompt.split("\n").length > PREVIEW_MAX_LINES) text += theme.fg("dim", " …");
				return new Text(text, 0, 0);
			},
			renderResult(result, { expanded, isPartial }, theme) {
				if (isPartial) {
					const status = result.content[0]?.type === "text" ? result.content[0].text : "working...";
					return new Text(theme.fg("mdLink", "◉ Claude Code ") + theme.fg("muted", status), 0, 0);
				}

				const details = result.details as { prompt?: string; executionTime?: number; actions?: string; error?: boolean } | undefined;
				const body = result.content[0]?.type === "text" ? result.content[0].text : "";

				let text = details?.error
					? theme.fg("error", "✗ Claude Code error")
					: theme.fg("mdLink", "✓ Claude Code");

				if (details?.executionTime) text += ` ${theme.fg("dim", `${(details.executionTime / 1000).toFixed(1)}s`)}`;
				if (details?.actions) text += ` ${theme.fg("muted", details.actions)}`;

				if (expanded) {
					if (details?.prompt) text += `\n${theme.fg("dim", `Prompt: ${details.prompt}`)}`;
					if (details?.prompt && body) text += `\n${theme.fg("dim", "─".repeat(40))}`;
					if (body) text += `\n${theme.fg("toolOutput", body)}`;
				} else {
					const truncated = body.length > PREVIEW_MAX_CHARS ? body.substring(0, PREVIEW_MAX_CHARS) : body;
					const lines = truncated.split("\n").slice(0, PREVIEW_MAX_LINES);
					if (lines.length) text += `\n${theme.fg("toolOutput", lines.join("\n"))}`;
					if (body.length > PREVIEW_MAX_CHARS || body.split("\n").length > PREVIEW_MAX_LINES) text += `\n${theme.fg("dim", `… (${keyHint("app.tools.expand", "to expand")})`)}`;

				}

				return new Text(text, 0, 0);
			},
			async execute(_id, params, signal, onUpdate, ctx) {
				// Guard: circular delegation
				if (ctx.model?.baseUrl === "claude-bridge") {
					debug("askClaude: blocked circular delegation (active model already uses Claude Code)");
					return {
						content: [{ type: "text" as const, text: "Error: AskClaude cannot be used when the active model already runs through Claude Code." }],
						details: { error: true },
					};
				}

				const mode = (params.mode ?? defaultMode) as "full" | "read" | "none";
				const isolated = params.isolated ?? false;
				const toolCalls = new Map<string, ToolCallState>();
				const start = Date.now();

				const progressInterval = setInterval(() => {
					const elapsed = ((Date.now() - start) / 1000).toFixed(0);
					const summary = buildActionSummary(toolCalls);
					const status = summary ? `${elapsed}s — ${summary}` : `${elapsed}s — working...`;
					onUpdate?.({
						content: [{ type: "text", text: status }],
						details: { prompt: params.prompt, executionTime: Date.now() - start },
					});
				}, 1000);

				try {
					const result = await promptAndWait(params.prompt, mode, toolCalls, signal, {
						systemPrompt: ctx.getSystemPrompt(),
						model: params.model,
						thinking: params.thinking,
						isolated,
						context: isolated ? undefined : buildSessionContext(ctx.sessionManager.getBranch()).messages as Context["messages"],
					});
					clearInterval(progressInterval);
					onUpdate?.({ content: [{ type: "text", text: "" }], details: {} });
					const executionTime = Date.now() - start;
					const actions = buildActionSummary(toolCalls);

					const text = actions
						? `${result.responseText}\n\n[Claude Code actions: ${actions}]`
						: result.responseText;
					return {
						content: [{ type: "text" as const, text }],
						details: { prompt: params.prompt, executionTime, actions },
					};
				} catch (err) {
					clearInterval(progressInterval);
					debug(`askClaude error: mode=${mode}, model=${params.model ?? "default"}, isolated=${isolated}, elapsed=${((Date.now() - start) / 1000).toFixed(1)}s, error=`, err);
					const msg = errorMessage(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						details: { prompt: params.prompt, executionTime: Date.now() - start, error: true },
					};
				}
			},
		});
	}
}
