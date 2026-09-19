// Bridge runtime: the persistent query/session/MCP state machine.
//
// Owns the doppel registry, the SDK-backed transcript store, the active-query set,
// MCP pending-result routing, the persistent input queue, and the full query
// lifecycle. Session state itself lives on the doppel a turn addresses (src/doppel.ts).

import { randomUUID } from "node:crypto";
import {
  type McpServerConfig,
  type Options,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
// Server's @deprecated tag steers high-level users toward McpServer, whose
// pre-handler validation is exactly what buildMcpServers must escape; the tag
// itself sanctions low-level Server for "advanced use cases".
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { deleteSession } from "cc-session-io";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CommandUsageObservation, CoreResponseEvent } from "./core-response.js";
import { isDeadQueryFailure } from "./dead-query.js";
import { debug, diagDump, makeCliDebugOptions } from "./debug.js";
import {
  applySessionSync,
  createDoppelRegistry,
  type Doppel,
  planReplaySync,
  planSessionSync,
  type SessionState,
  type SyncPlan,
} from "./doppel.js";
import { errorMessage } from "./errors.js";
import type { McpContent, McpResult } from "./extract-tool-results.js";
import { createProviderStreamRuntime } from "./provider-stream.js";
import { PushQueue, type QueryContext } from "./query-state.js";
import type { RefusalEntryData } from "./refusal-data.js";
import type { RuntimeRequest } from "./runtime-request.js";
import { sdkChildEnv } from "./sdk-child-env.js";
import { awaitQueryInitialization, reconcileMcpServers } from "./sdk-signals.js";
import { BridgeSessionStore, MalformedSessionTranscriptError } from "./session-store.js";
import { MCP_SERVER_NAME } from "./skills.js";

type RuntimeTool = import("@anthropic-ai/sdk/resources/messages/messages").Tool;

export interface BridgeRuntimeDependencies {
  queryFactory?(request: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
  sessionStore?: BridgeSessionStore;
  notify?(message: string, level: "info" | "warning" | "error"): void;
  refusal?(customType: string, data: RefusalEntryData): void;
  observeServedModel?(id: string): void | Promise<void>;
  observeCommandUsage?(observation: CommandUsageObservation): void;
}

/** The spawn-shaped half of a turn: what a fresh subprocess is given, derived from the
 *  request alone, plus the MCP server bound to the context that will run it. */
interface FreshTurn {
  mcpTools: RuntimeTool[];
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
  cwd: string;
  cliModel: string;
  spawnSignature: string;
  mcpSignature: string;
  mcpServers: Record<string, McpServerConfig>;
  queryOptions: Options;
}

interface FreshQueryRequest extends FreshTurn {
  queryCtx: QueryContext;
  syncPlan: SyncPlan;
  model: string;
  contextMessageCount: number;
  /** The host's own query survives the turn; every other query is a one-shot. */
  persistent: boolean;
  /** The query being replaced finished cleanly, so it is drained instead of abandoned. */
  drainExisting: boolean;
  promptMessage: SDKUserMessage;
  attachAbort(): void;
}

type SessionDisposition = "rebuild" | "drop";

/** The prompt that re-enters a turn whose history needs none: pi has delivered every tool
 *  result, and the replay's transcript ends with them. The subprocess is told what it
 *  missed, because a bare "continue" reads to the model as a conversation already finished
 *  and gets "there's no work in progress" instead of the answer. */
const REPLAY_PROMPT =
  "Your previous reply was interrupted before you could use the tool results above. Continue from them.";

export const SESSION_STORE_LOAD_TIMEOUT_MS = 15_000;

export function createBridgeRuntime(dependencies: BridgeRuntimeDependencies = {}) {
  const queryFactory = dependencies.queryFactory ?? query;

  const doppels = createDoppelRegistry();
  const sessionStore = dependencies.sessionStore ?? new BridgeSessionStore(debug);
  const activeQueryContexts = new Set<QueryContext>();

  const {
    claimCurrentResponse,
    emitTerminalError,
    finalizeCurrentResponse,
    replayBufferedSdkMessages,
    consumeQuery,
  } = createProviderStreamRuntime({
    debug,
    notify: dependencies.notify,
    appendEntry: dependencies.refusal,
    observeServedModel: (id) => {
      Promise.resolve(dependencies.observeServedModel?.(id)).catch((error) =>
        debug("provider: recording the served model failed", error),
      );
    },
  });

  function extractAllToolResults(messages: MessageParam[]): McpResult[] {
    const results: McpResult[] = [];
    let stopIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant") {
        stopIdx = i;
        break;
      }
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        const content: McpContent = [];
        if (Array.isArray(block.content)) {
          for (const item of block.content) {
            if (item.type === "text") content.push({ type: "text", text: item.text });
            else if (item.type === "image" && item.source.type === "base64")
              content.push({
                type: "image",
                data: item.source.data,
                mimeType: item.source.media_type,
              });
          }
        } else content.push({ type: "text", text: block.content ?? "" });
        results.push({
          toolCallId: block.tool_use_id,
          isError: block.is_error,
          content: content.length ? content : [{ type: "text", text: "" }],
        });
      }
    }
    debug(
      `extractAllToolResults: ${results.length} results from ${messages.length} msgs, stopped at index ${stopIdx}`,
    );
    for (let r = 0; r < results.length; r++) {
      debug(
        `extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`,
        JSON.stringify(results[r].content).slice(0, 150),
      );
    }
    return results;
  }

  /** Extract the last user message from context as a prompt string. Returns null if last message is not a user message. */
  function extractUserPrompt(messages: MessageParam[]): string | null {
    const last = messages[messages.length - 1];
    if (last?.role !== "user") return null;
    if (typeof last.content === "string") return last.content;
    if (!Array.isArray(last.content)) return "";
    return last.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  /** Extract the last user message as ContentBlockParam[] (preserving images).
   *  Returns null if no images — caller should fall back to string prompt. */
  function extractUserPromptBlocks(messages: MessageParam[]): ContentBlockParam[] | null {
    const last = messages[messages.length - 1];
    if (last?.role !== "user") return null;
    if (typeof last.content === "string") {
      debug(`extractUserPromptBlocks: content is string (length=${last.content.length})`);
      return null;
    }
    if (!Array.isArray(last.content)) {
      debug(`extractUserPromptBlocks: content is ${typeof last.content}`);
      return null;
    }
    debug(
      `extractUserPromptBlocks: ${last.content.length} blocks, types=${last.content.map((b) => b.type).join(",")}`,
    );
    let hasImage = false;
    const blocks: ContentBlockParam[] = [];
    for (const block of last.content) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "image" && block.source.type === "base64") {
        hasImage = true;
        blocks.push(block);
      }
    }
    return hasImage ? blocks : null;
  }

  function sdkPrompt(content: string | ContentBlockParam[]): SDKUserMessage {
    return {
      type: "user",
      message: { role: "user", content } as MessageParam,
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
  }

  function sdkUserMessage(messages: MessageParam[]): SDKUserMessage {
    const blocks = extractUserPromptBlocks(messages);
    const text = extractUserPrompt(messages);
    if (!blocks && !text) {
      diagDump("empty_prompt", {
        contextLength: messages.length,
        lastMsgRole: messages.at(-1)?.role,
        messageRoles: messages.map((message, index) => `[${index}]${message.role}`).join(" "),
      });
    }
    return sdkPrompt(blocks ?? text ?? "[continue]");
  }

  function contextForToolResults(results: McpResult[]): QueryContext | undefined {
    for (const result of results) {
      const id = result.toolCallId;
      if (!id) continue;
      for (const queryCtx of activeQueryContexts) {
        if (
          queryCtx.hasPendingToolCall(id) ||
          queryCtx.pendingResults.has(id) ||
          queryCtx.shownToolCallIds.has(id)
        ) {
          return queryCtx;
        }
      }
    }
    return undefined;
  }

  const MCP_HANDLER_EXTRA_SCHEMA = Type.Object({
    _meta: Type.Object({
      "claudecode/toolUseId": Type.String(),
    }),
  });

  /** pi's history and Claude Code's transcript disagree about a tool call, and no further */
  function failReconciliation(queryCtx: QueryContext, message: string): void {
    emitTerminalError(queryCtx, "error", message);
    void closeQueryContext(queryCtx, message, "force");
  }

  function failMcpBridge(queryCtx: QueryContext): void {
    const message =
      "Claude bridge incompatible with this Claude Code version: CLI no longer sends claudecode/toolUseId in MCP tool metadata";
    debug(`provider: fatal MCP bridge error: ${message}`);
    dependencies.notify?.(message, "error");
    queryCtx.fatalError = message;
    failReconciliation(queryCtx, message);
  }

  function createMcpToolHandler(toolName: string, queryCtx: QueryContext) {
    return async (_args: unknown, extra: unknown): Promise<McpResult> => {
      if (!Value.Check(MCP_HANDLER_EXTRA_SCHEMA, extra)) {
        failMcpBridge(queryCtx);
        // Never return a tool result after a fatal bridge error; the closed query must remain terminal.
        return new Promise<McpResult>(() => {});
      }
      const toolCallId = extra._meta["claudecode/toolUseId"];
      queryCtx.dispatchedToolCallIds.add(toolCallId);
      const queued = queryCtx.pendingResults.get(toolCallId);
      if (queued) {
        queryCtx.pendingResults.delete(toolCallId);
        debug(
          `mcp handler: ${toolName} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`,
        );
        return queued;
      }
      debug(`mcp handler: ${toolName} [${toolCallId}] → waiting`);
      return queryCtx.blockOnToolResult(toolCallId, toolName);
    };
  }

  // Creates an MCP server that bridges pi tools to the SDK. Each tool handler
  // blocks on a Promise until pi delivers the matching tool result.
  //
  // Built on the low-level MCP Server rather than createSdkMcpServer: that helper
  // takes Zod shapes and validates arguments before the handler runs, which drops
  // the generator backpressure for a call Claude Code streamed — the deadlock in
  // docs/investigations/01-unmatched-tool-call-deadlock.md. Here every correctly
  // named call reaches the handler and pi's TypeBox validation is the sole
  // argument gate; pi's schemas are also advertised verbatim instead of through a
  // lossy Zod translation. The Agent SDK only calls `instance.connect(transport)`
  // on an sdk server config, so a low-level Server satisfies it; see the import
  // for why Server's deprecation tag does not apply here.
  function advertisedInputSchema(tool: RuntimeTool): { type: "object" } {
    const schemaType = (tool.input_schema as { type?: unknown }).type;
    if (schemaType !== "object")
      throw new Error(
        `Claude bridge: tool ${tool.name} input_schema must be an object schema, got ${JSON.stringify(schemaType)}`,
      );
    // pi types parameters as TSchema, which hides `type`; the check above proves
    // the literal MCP requires.
    return tool.input_schema as { type: "object" };
  }

  function buildMcpServers(
    tools: RuntimeTool[],
    queryCtx: QueryContext,
  ): Record<string, McpServerConfig> {
    if (!tools.length) return {};
    const handlers = new Map(
      tools.map((tool) => [tool.name, createMcpToolHandler(tool.name, queryCtx)]),
    );
    const server = new McpLowLevelServer(
      { name: MCP_SERVER_NAME, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: advertisedInputSchema(tool),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const handler = handlers.get(request.params.name);
      if (!handler)
        throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
      return handler(request.params.arguments, { _meta: request.params._meta });
    });
    return {
      [MCP_SERVER_NAME]: {
        type: "sdk",
        name: MCP_SERVER_NAME,
        instance: server as never,
      },
    };
  }

  function clearToolCallTracking(c: QueryContext): void {
    c.shownToolCallIds.clear();
    c.dispatchedToolCallIds.clear();
    c.rejectedToolCallIds.clear();
    c.rejectionWindowOpen = false;
    c.bufferedSdkMessages = [];
  }

  type QueryCloseMode = "drain" | "force";

  function closeQueryContext(c: QueryContext, label: string, mode: QueryCloseMode): Promise<void> {
    const doppel = c.doppel;
    // A force close abandons the query mid-turn, so pi's history and the Claude Code session
    // have parted ways — including when there is nothing left to close, which is how an
    // interrupt that kept queued input arrives here.
    if (mode === "force" && doppel.session)
      doppel.session = { ...doppel.session, rebuildReason: `force-close:${label}` };
    // Nothing can address an ephemeral again once its own turn is over.
    if (doppel.kind === "ephemeral" && c === doppel.context) doppels.discard(doppel);
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
      try {
        activeQuery?.close();
      } catch {}
    }
    c.releasePendingToolCalls("Query ended");
    c.pendingResults.clear();
    clearToolCallTracking(c);
    c.activeQuery = null;
    c.inputQueue = null;
    c.readyForInput = false;
    activeQueryContexts.delete(c);
    const completion = c.completion ?? Promise.resolve();
    const finishClose = () => {
      storeWriter?.close();
      if (localSessionFragment) {
        deleteSession(
          localSessionFragment.sessionId,
          localSessionFragment.cwd,
          localSessionFragment.claudeDir,
        );
        debug(
          `provider: deleted first-spawn session fragment ${localSessionFragment.sessionId.slice(0, 8)}`,
        );
      }
      if (doppel.kind === "ephemeral" && doppel.session) {
        sessionStore.delete(doppel.session.sessionId);
        debug(
          `doppel: ${doppel.label} closed, deleted session ${doppel.session.sessionId.slice(0, 8)}`,
        );
        doppel.session = null;
      }
      if (c.sessionStoreWriter === storeWriter) c.sessionStoreWriter = null;
      if (c.localSessionFragment === localSessionFragment) c.localSessionFragment = null;
      if (c.closeCompletion === closeCompletion) c.closeCompletion = null;
      // A subprocess that died rejects its completion, and this close swallows that rejection by
      // passing finishClose to both arms. Leaving the rejected promise on the context would let the
      // nothing-to-close guard above hand it back raw, so the next caller to ask "anything to close?"
      // inherits the corpse of a query that died long before it got here.
      if (c.completion === completion) c.completion = null;
    };
    const closeCompletion = completion.then(finishClose, finishClose);
    c.closeCompletion = closeCompletion;
    return closeCompletion;
  }

  /** The host's warm query, the only one that outlives a turn. */
  function closePersistentQuery(label: string): Promise<void> {
    if (doppels.hostKey === null) return Promise.resolve();
    const c = doppels.host().context;
    if (!c.persistent) return Promise.resolve();
    return closeQueryContext(c, label, c.readyForInput ? "drain" : "force");
  }

  /** A query no turn can use again. The force close marks the shared session for rebuild
   *  on its own, so only dropping the session outright needs saying here. */
  function discardQuery(c: QueryContext, message: string, disposition: SessionDisposition): void {
    if (disposition === "drop") c.doppel.session = null;
    void closeQueryContext(c, message, "force");
  }

  /**
   * A query can die out from under a turn: pushed into after the subprocess quietly
   * exited, torn down with a control request still pending, or holding OAuth credentials
   * the server revoked while a sibling process rotated them. None of that is a verdict on
   * the request, and a fresh subprocess re-reads the credential store, so the turn is
   * respawned and replayed once.
   *
   * Only before any assistant output reaches pi. Once the turn has started streaming, a
   * replay would deliver the same content twice into a stream pi is already rendering, and
   * there is no stream-reset primitive to take it back.
   */
  function retryDeadQuery(
    c: QueryContext,
    message: string,
    disposition: SessionDisposition,
  ): boolean {
    if (!isDeadQueryFailure(message)) return false;
    const retry = c.turnRetry;
    if (!retry) {
      debug(
        `provider: dead query not retried, retry already spent or the turn moved on: ${message}`,
      );
      return false;
    }
    if (c.turnAborted) {
      debug(`provider: dead query not retried, the user aborted the turn: ${message}`);
      return false;
    }
    if (c.turnStarted) {
      debug(`provider: dead query not retried, assistant output already reached pi: ${message}`);
      return false;
    }
    c.turnRetry = null;
    debug(
      `provider: dead query, retrying the turn once on a fresh subprocess (${disposition}): ${message}`,
    );
    // The pi stream outlives the respawn and the retry re-claims it; left attached it would
    // read as a live stream overwritten before its terminal event.
    c.currentResponse = null;
    discardQuery(c, `dead query retry: ${message}`, disposition);
    retry();
    return true;
  }

  function failQuery(
    c: QueryContext,
    reason: "aborted" | "error",
    message: string,
    disposition: SessionDisposition,
  ): void {
    if (reason === "error" && retryDeadQuery(c, message, disposition)) return;
    emitTerminalError(c, reason, message);
    discardQuery(c, message, disposition);
  }

  function invalidResumeMaterialization(error: unknown): boolean {
    if (error instanceof MalformedSessionTranscriptError) return true;
    // SDK 0.3.219's resume materializer and Claude subprocess expose only plain Error messages.
    return /SessionStore\.(?:load|listSubkeys)\(\) timed out|No conversation found|invalid (?:resume|transcript)|malformed (?:resume|transcript)/i.test(
      errorMessage(error),
    );
  }

  function invalidateStoredSession(doppel: Doppel, sessionId: string, reason: string): void {
    sessionStore.delete(sessionId);
    if (doppel.session?.sessionId === sessionId)
      doppel.session = { ...doppel.session, rebuildReason: `invalid-resume:${reason}` };
    debug(`provider: invalidated session ${sessionId.slice(0, 8)} (${reason})`);
  }

  function settleInterruptedQuery(c: QueryContext): void {
    if (!c.turnAborted || !c.turnInterruptReceiptReceived) return;
    if (c.turnInterruptQueuedIds.length > 0) {
      failQuery(
        c,
        "aborted",
        "Operation aborted; Claude retained queued input, so the session will rebuild",
        "rebuild",
      );
      return;
    }
    if (!c.turnResultVerdict) return;
    if (!c.turnSawAbortedAssistant && c.turnResultVerdict.type !== "interrupted") {
      failQuery(
        c,
        "aborted",
        "Operation aborted without complete Claude cancellation metadata; the session will rebuild",
        "rebuild",
      );
      return;
    }
    c.readyForInput = c.persistent;
    c.turnAborted = false;
    c.abortCleanup?.();
    c.abortCleanup = null;
    debug(
      "provider: interrupted query is reusable after empty receipt and terminal abort metadata",
    );
  }

  async function spawnFreshQuery(request: FreshQueryRequest): Promise<void> {
    const {
      queryCtx,
      syncPlan,
      cwd,
      customToolNameToPi,
      model,
      contextMessageCount,
      persistent,
      drainExisting,
      spawnSignature,
      mcpSignature,
      mcpTools,
      mcpServers,
      cliModel,
      promptMessage,
      attachAbort,
    } = request;
    const doppel = queryCtx.doppel;
    try {
      if (queryCtx.closeCompletion) await queryCtx.closeCompletion;
      if (queryCtx.activeQuery) {
        await closeQueryContext(
          queryCtx,
          syncPlan.path === "reuse" ? "query options changed" : syncPlan.path,
          drainExisting ? "drain" : "force",
        );
      }
      const syncResult = applySessionSync({
        doppel,
        plan: syncPlan,
        cwd,
        sessionStore,
        modelId: model,
      });
      // Whatever ran here before is gone, closed above or dead; nothing it left blocked can
      // be answered by the query about to replace it.
      queryCtx.releasePendingToolCalls("Query ended");
      queryCtx.pendingResults.clear();
      clearToolCallTracking(queryCtx);
      queryCtx.persistent = persistent;
      queryCtx.closing = false;
      queryCtx.spawnSignature = spawnSignature;
      queryCtx.mcpSignature = mcpSignature;
      queryCtx.hasMcpServer = mcpTools.length > 0;
      queryCtx.cliModel = cliModel;
      queryCtx.modelUsageSnapshot = {};
      const inputQueue = new PushQueue<SDKUserMessage>();
      queryCtx.inputQueue = inputQueue;
      const writerLabel = persistent ? "provider" : "provider-child";
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
      debug(
        "provider: fresh streaming query",
        `model=${cliModel} msgs=${contextMessageCount} tools=${mcpTools.length}`,
        `doppel=${doppel.label} resume=${syncResult.sessionId?.slice(0, 8) ?? "none"} effort=${queryOptions.effort ?? "default"} persistent=${persistent}`,
      );

      const sdkQuery = queryFactory({
        prompt: inputQueue,
        options: queryOptions,
      });
      queryCtx.activeQuery = sdkQuery;
      activeQueryContexts.add(queryCtx);
      attachAbort();

      const completion = consumeQuery(sdkQuery, customToolNameToPi, model, queryCtx, {
        onResult(result) {
          if (queryCtx.closing) return;
          const verdict = queryCtx.turnResultVerdict;
          // Claude Code can report a dead-query failure as a result instead of a rejection —
          // notably a revoked token, which it answers rather than throws.
          if (verdict?.type === "terminal" && retryDeadQuery(queryCtx, verdict.message, "rebuild"))
            return;
          if (queryCtx.turnAborted) emitTerminalError(queryCtx, "aborted", "Operation aborted");
          else {
            queryCtx.abortCleanup?.();
            queryCtx.abortCleanup = null;
            finalizeCurrentResponse(queryCtx);
          }
          const sessionId = result.session_id ?? doppel.session?.sessionId;
          if (sessionId) {
            doppel.session = { sessionId, cursor: queryCtx.latestCursor };
            debug(
              `provider: turn complete, doppel=${doppel.label}, session=${sessionId.slice(0, 8)}, cursor=${queryCtx.latestCursor}, storedRecords=${sessionStore.entryCount(sessionId)}`,
            );
          }
          if (!verdict) {
            failQuery(queryCtx, "error", "Claude result was not classified", "rebuild");
          } else if (queryCtx.turnAborted) {
            settleInterruptedQuery(queryCtx);
          } else if (verdict.type === "interrupted") {
            failQuery(
              queryCtx,
              "aborted",
              "Claude aborted the turn without an interrupt receipt; the session will rebuild",
              "rebuild",
            );
          } else if (verdict.type === "reusable") {
            queryCtx.readyForInput = queryCtx.persistent;
          } else {
            queryCtx.readyForInput = false;
            void closeQueryContext(
              queryCtx,
              `terminal result ${result.terminal_reason ?? result.subtype}`,
              "drain",
            );
          }
          if (!queryCtx.persistent)
            void closeQueryContext(queryCtx, "one-shot turn complete", "drain");
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
              ...(process.env.CLAUDE_CONFIG_DIR
                ? { claudeDir: process.env.CLAUDE_CONFIG_DIR }
                : {}),
            };
          }
          doppel.session = { sessionId, cursor: queryCtx.latestCursor };
        },
        onMirrorError(message) {
          invalidateStoredSession(doppel, message.key.sessionId, `mirror_error: ${message.error}`);
          dependencies.notify?.(`Claude transcript mirror failed: ${message.error}`, "error");
          if (!queryCtx.closing)
            failQuery(
              queryCtx,
              "error",
              `Claude transcript mirror failed: ${message.error}`,
              "rebuild",
            );
        },
      });
      queryCtx.completion = completion;
      void completion
        .then(() => {
          debug(
            `consumeQuery: query exited, closing=${queryCtx.closing} persistent=${queryCtx.persistent}`,
          );
          if (!queryCtx.closing && queryCtx.activeQuery === sdkQuery) {
            failQuery(
              queryCtx,
              queryCtx.turnAborted ? "aborted" : "error",
              queryCtx.turnAborted ? "Operation aborted" : "Claude Code query ended unexpectedly",
              queryCtx.turnAborted ? "rebuild" : "drop",
            );
          }
        })
        .catch((error) => {
          debug("provider: query consumer error", error);
          if (!queryCtx.closing) {
            const invalidResume = Boolean(
              syncResult.sessionId &&
                !queryCtx.turnResultVerdict &&
                invalidResumeMaterialization(error),
            );
            if (syncResult.sessionId && invalidResume)
              invalidateStoredSession(doppel, syncResult.sessionId, errorMessage(error));
            failQuery(
              queryCtx,
              queryCtx.turnAborted ? "aborted" : "error",
              queryCtx.turnAborted ? "Operation aborted" : errorMessage(error),
              queryCtx.turnAborted || invalidResume ? "rebuild" : "drop",
            );
          }
        });
      await awaitQueryInitialization(sdkQuery);
      if (!queryCtx.closing) {
        inputQueue.push(promptMessage);
        // A one-shot query takes no further input: the turn it was spawned for is all of it.
        if (!persistent) inputQueue.end();
      }
    } catch (error) {
      if (doppel.session && invalidResumeMaterialization(error))
        invalidateStoredSession(doppel, doppel.session.sessionId, errorMessage(error));
      failQuery(queryCtx, "error", errorMessage(error), doppel.session ? "rebuild" : "drop");
    }
  }

  /** Frontend-neutral entry point. The request is already Anthropic history and SDK policy. */
  function run(
    request: RuntimeRequest,
  ): import("./core-response.js").PushStream<CoreResponseEvent> {
    if (request.ephemeral === Boolean(request.conversationKey))
      throw new Error(
        "RuntimeRequest must provide exactly one of conversationKey or ephemeral: true",
      );
    const native = new PushQueue<CoreResponseEvent>();
    const stream = native;
    const model = request.model;
    const nativeMessages = request.messages;
    const nativeCursor = nativeMessages.length;
    const lastMsg = nativeMessages.at(-1);
    const lastUserBlocks =
      lastMsg?.role === "user" && Array.isArray(lastMsg.content) ? lastMsg.content : [];
    const lastHasToolResult = lastUserBlocks.some((block) => block.type === "tool_result");
    const lastHasUserInput =
      lastMsg?.role === "user" &&
      (typeof lastMsg.content === "string" ||
        lastUserBlocks.some((block) => block.type === "text" || block.type === "image"));
    debug(
      `provider: run called, conversationKey=${request.conversationKey?.slice(0, 8) ?? "ephemeral"}, lastRole=${lastMsg?.role}`,
    );

    /** Wires pi's abort signal for this call to the query that answers it. */
    function attachAbortTo(queryCtx: QueryContext): void {
      queryCtx.abortCleanup?.();
      if (!request.signal) return;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        queryCtx.turnAborted = true;
        queryCtx.readyForInput = false;
        queryCtx.releasePendingToolCalls("Operation aborted");
        queryCtx.rejectionWindowOpen = false;
        queryCtx.bufferedSdkMessages = [];
        const activeQuery = queryCtx.activeQuery;
        if (!activeQuery) {
          failQuery(queryCtx, "aborted", "Operation aborted", "rebuild");
          return;
        }
        void activeQuery
          .interrupt()
          .then((receipt) => {
            if (!queryCtx.turnAborted || queryCtx.closing) return;
            queryCtx.turnInterruptReceiptReceived = true;
            queryCtx.turnInterruptQueuedIds = receipt?.still_queued ?? ["unverified-queued-input"];
            debug(`provider: interrupt receipt queued=${queryCtx.turnInterruptQueuedIds.length}`);
            settleInterruptedQuery(queryCtx);
          })
          .catch((error) => {
            debug("provider: graceful interrupt failed", error);
            failQuery(queryCtx, "aborted", "Operation aborted", "rebuild");
          });
        killTimer = setTimeout(() => {
          if (!queryCtx.turnAborted || queryCtx.readyForInput) return;
          debug("provider: interrupt timed out; forcing query close");
          failQuery(queryCtx, "aborted", "Operation aborted", "rebuild");
        }, 5000);
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
      queryCtx.abortCleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        request.signal?.removeEventListener("abort", onAbort);
      };
    }

    function planFreshTurn(queryCtx: QueryContext, persistent: boolean): FreshTurn {
      const mcpTools = request.tools ?? [];
      const customToolNameToSdk = request.toolNameToSdk ?? new Map<string, string>();
      const customToolNameToPi = request.toolNameToClient ?? new Map<string, string>();
      const cwd = request.cwd;
      const cliModel = request.sdkModel ?? request.model;
      const queryOptions: Options = {
        cwd,
        env: sdkChildEnv({ DISABLE_AUTO_COMPACT: "1" }),
        tools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        strictMcpConfig: true,
        ...request.options,
        systemPrompt: request.systemPrompt,
        model: cliModel,
        ...(request.effort ? { effort: request.effort } : {}),
        ...makeCliDebugOptions(persistent ? "provider" : "provider-child"),
      };
      const spawnSignature = JSON.stringify({
        cwd,
        cliModel,
        systemPrompt: request.systemPrompt,
        effort: request.effort,
      });
      const toolSignature = JSON.stringify(
        mcpTools.map(({ name, description, input_schema }) => ({
          name,
          description,
          input_schema,
        })),
      );
      return {
        mcpTools,
        customToolNameToSdk,
        customToolNameToPi,
        cwd,
        cliModel,
        spawnSignature,
        mcpSignature: toolSignature,
        mcpServers: buildMcpServers(mcpTools, queryCtx),
        queryOptions,
      };
    }

    /** The subprocess a turn runs on, for a turn's first attempt and for the replay of
     *  one whose query died before any of it reached pi. */
    function spawnTurn(request: {
      queryCtx: QueryContext;
      freshTurn: FreshTurn;
      syncPlan: SyncPlan;
      promptMessage: SDKUserMessage;
      persistent: boolean;
      drainExisting: boolean;
    }): void {
      void spawnFreshQuery({
        ...request.freshTurn,
        queryCtx: request.queryCtx,
        syncPlan: request.syncPlan,
        model,
        contextMessageCount: nativeMessages.length,
        persistent: request.persistent,
        drainExisting: request.drainExisting,
        promptMessage: request.promptMessage,
        attachAbort: () => attachAbortTo(request.queryCtx),
      });
    }

    const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(nativeMessages) : [];
    const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;

    if (resultCtx) {
      if (resultCtx.fatalError) {
        resultCtx.beginCommand(model, native);
        claimCurrentResponse(resultCtx.currentResponse, "tool-result-error", resultCtx);
        resultCtx.observeCommandUsage = dependencies.observeCommandUsage;
        emitTerminalError(resultCtx, "error", resultCtx.fatalError);
        return stream;
      }
      resultCtx.activeModel = model;
      resultCtx.resetTurnState(model, native);
      claimCurrentResponse(resultCtx.currentResponse, "tool-result", resultCtx);
      resultCtx.observeCommandUsage = dependencies.observeCommandUsage;
      resultCtx.latestCursor = nativeCursor;
      debug(
        `provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCallCount} waiting handlers, msgs=${nativeMessages.length}`,
      );

      // A warm query can be hours old by the time pi answers its tool call, and die on the
      // first request it makes with the answer. Pi's history already carries the results,
      // so the turn is replayable: discard the corpse, rebuild the whole conversation —
      // results included — into a fresh session, and let the same pi stream take the reply.
      // Armed after resetTurnState, which clears it, so exactly one replay per turn.
      let replayed = false;
      resultCtx.turnRetry = () => {
        replayed = true;
        const queryCtx = resultCtx;
        const doppel = queryCtx.doppel;
        const persistent = doppel.kind === "host" && queryCtx === doppel.context;
        // A trailing user message is steering pi has not handed to Claude Code yet, so it
        // is the replay's prompt; otherwise the history ends at the results and the replay
        // only asks the fresh subprocess to carry on.
        const steering = lastHasUserInput;
        debug(
          `provider: replaying the tool-result continuation on a fresh subprocess (doppel=${doppel.label}, ${allResults.length} result(s) already in pi's history, prompt=${steering ? "steering" : "replay"}, persistent=${persistent})`,
        );
        queryCtx.activeModel = model;
        queryCtx.restartTurnState(model, native);
        claimCurrentResponse(queryCtx.currentResponse, "tool-result-replay", queryCtx);
        queryCtx.fatalError = null;
        spawnTurn({
          queryCtx,
          freshTurn: planFreshTurn(queryCtx, persistent),
          syncPlan: steering
            ? planSessionSync(nativeMessages, doppel.session)
            : planReplaySync(nativeMessages, doppel.session),
          promptMessage: steering ? sdkUserMessage(nativeMessages) : sdkPrompt(REPLAY_PROMPT),
          persistent,
          drainExisting: false,
        });
      };

      if (lastHasUserInput) {
        if (resultCtx.persistent && resultCtx.inputQueue) {
          resultCtx.inputQueue.push(sdkUserMessage(nativeMessages));
          debug(
            `provider: queued native steering message: ${extractUserPrompt(nativeMessages)?.slice(0, 60) ?? "[image]"}`,
          );
        } else {
          debug("provider: ignored steering for a one-shot query");
        }
      }

      // Anything Claude Code streamed while pi was executing is older than what the
      // unblocked generator will produce, so it replays into the fresh turn first.
      replayBufferedSdkMessages(resultCtx);
      // A buffered result can be the death itself, replayed into this call. The turn now
      // belongs to the fresh subprocess: these results are in the session it rebuilt from,
      // and the handlers that were waiting for them died with the query.
      if (replayed) return stream;

      for (const result of allResults) {
        const id = result.toolCallId;
        if (!id) {
          debug("WARNING: tool result without toolCallId, cannot match");
          continue;
        }
        const answered = resultCtx.deliverToolResult(id, result);
        if (answered) {
          debug(
            `provider: resolving ${answered} [${id}]${result.isError ? " (error)" : ""}`,
            JSON.stringify(result.content).slice(0, 200),
          );
        } else if (resultCtx.rejectedToolCallIds.has(id)) {
          // Claude Code already answered this call with its own error; a second
          // answer would be a duplicate reply to a closed question.
          debug(`provider: dropping result for Claude-rejected call [${id}]`);
        } else if (resultCtx.shownToolCallIds.has(id)) {
          resultCtx.pendingResults.set(id, result);
          debug(`provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`);
        } else {
          failReconciliation(
            resultCtx,
            `Claude bridge: pi delivered a result for tool call [${id}], which was never streamed to pi`,
          );
          return stream;
        }
      }
      if (resultCtx.pendingToolCallCount > 0) {
        const waiting = resultCtx.pendingToolCallIds.join(", ");
        failReconciliation(
          resultCtx,
          `Claude bridge: ${resultCtx.pendingToolCallCount} tool handler(s) still waiting after ${allResults.length} result(s) [${waiting}]`,
        );
        return stream;
      }
      if (resultCtx.doppel.session) resultCtx.doppel.session.cursor = nativeCursor;
      return stream;
    }

    if (lastHasToolResult && request.explicitReplay) {
      const doppel = doppels.resolve(request.conversationKey);
      const replayCtx = doppel.context;
      const persistent = doppel.kind === "host";
      replayCtx.activeModel = model;
      replayCtx.beginCommand(model, native);
      claimCurrentResponse(replayCtx.currentResponse, "explicit-tool-result-replay", replayCtx);
      replayCtx.observeCommandUsage = dependencies.observeCommandUsage;
      replayCtx.latestCursor = nativeCursor;
      replayCtx.fatalError = null;
      debug(`provider: explicitly replaying imported tool-result history (doppel=${doppel.label})`);
      spawnTurn({
        queryCtx: replayCtx,
        freshTurn: planFreshTurn(replayCtx, persistent),
        syncPlan: planReplaySync(nativeMessages, doppel.session),
        promptMessage: sdkPrompt(REPLAY_PROMPT),
        persistent,
        drainExisting: Boolean(replayCtx.activeQuery),
      });
      return stream;
    }

    if (lastHasToolResult && !lastHasUserInput) {
      debug("provider: orphaned tool result after abort, emitting end_turn");
      const doppel = doppels.resolve(request.conversationKey);
      const orphanCtx = doppel.context;
      if (doppel.session) doppel.session.cursor = nativeCursor;
      if (orphanCtx.fatalError) {
        orphanCtx.beginCommand(model, native);
        claimCurrentResponse(orphanCtx.currentResponse, "orphan-tool-result-error", orphanCtx);
        orphanCtx.observeCommandUsage = dependencies.observeCommandUsage;
        emitTerminalError(orphanCtx, "error", orphanCtx.fatalError);
        return stream;
      }
      queueMicrotask(() => {
        orphanCtx.beginCommand(model, native);
        claimCurrentResponse(orphanCtx.currentResponse, "orphan-tool-result", orphanCtx);
        orphanCtx.observeCommandUsage = dependencies.observeCommandUsage;
        // Deliberate completion, not a streamed one: no SDK query runs here, so the
        // acknowledgement has to name its own terminal state or finalize reads it
        // as a turn that died mid-stream.
        if (orphanCtx.turnOutput) orphanCtx.turnOutput.message.stop_reason = "end_turn";
        finalizeCurrentResponse(orphanCtx);
        orphanCtx.completeCommandUsage(model, null);
        if (doppel.kind === "ephemeral") doppels.discard(doppel);
      });
      return stream;
    }

    // One attempt at the turn. A dead query is discarded and the same turn replayed
    // here on attempt 1, into the same pi stream, against a fresh subprocess.
    function beginTurn(attempt: number): void {
      // Caller identity decides whose conversation this is: the doppel it addresses owns
      // the session, the query and the failures of every turn it runs, and can reach no
      // other doppel's. Only the host's query stays warm between turns.
      const doppel = doppels.resolve(request.conversationKey);
      const primary = doppel.context;
      const warmQuery = Boolean(primary.activeQuery && primary.persistent && primary.readyForInput);
      // Reentrancy proper: a turn arrived while this doppel's query is mid-flight.
      const isReentrant = Boolean(primary.activeQuery && !warmQuery);
      const queryCtx = isReentrant ? doppel.spawnContext() : primary;
      const persistent = !isReentrant && doppel.kind === "host";
      const syncPlan = planSessionSync(nativeMessages, doppel.session);
      const promptMessage = sdkUserMessage(nativeMessages);
      const freshTurn = planFreshTurn(queryCtx, persistent);

      const canPush = Boolean(
        warmQuery &&
          !isReentrant &&
          syncPlan.path === "reuse" &&
          queryCtx.spawnSignature === freshTurn.spawnSignature,
      );

      queryCtx.activeModel = model;
      queryCtx.beginCommand(model, native);
      claimCurrentResponse(
        queryCtx.currentResponse,
        canPush ? "persistent-reuse" : "fresh-query",
        queryCtx,
      );
      queryCtx.observeCommandUsage = dependencies.observeCommandUsage;
      // Installed after beginCommand, which clears it. Exactly one replay per turn: the
      // second attempt arms nothing, so a retry that dies the same way is reported.
      queryCtx.turnRetry = attempt === 0 ? () => beginTurn(attempt + 1) : null;
      queryCtx.latestCursor = nativeCursor;
      queryCtx.fatalError = null;

      if (canPush) {
        // canPush was decided from the warm query's own state, so losing either here means the
        // context was torn down underneath the decision. Raised before the async push so it
        // surfaces as a spawn failure instead of the turn's in-band error.
        const { activeQuery, inputQueue } = queryCtx;
        if (!activeQuery || !inputQueue)
          throw new Error("persistent reuse chosen without a live query to push into");
        applySessionSync({
          doppel,
          plan: syncPlan,
          cwd: freshTurn.cwd,
          sessionStore,
          modelId: model,
        });
        attachAbortTo(queryCtx);
        void (async () => {
          try {
            if (queryCtx.mcpSignature !== freshTurn.mcpSignature) {
              debug(
                `provider: reconciling MCP tools without process replacement (${queryCtx.hasMcpServer ? "replace/remove" : "add"})`,
              );
              await reconcileMcpServers(
                activeQuery,
                MCP_SERVER_NAME,
                queryCtx.hasMcpServer,
                freshTurn.mcpServers,
              );
              queryCtx.mcpSignature = freshTurn.mcpSignature;
              queryCtx.hasMcpServer = freshTurn.mcpTools.length > 0;
            }
            if (queryCtx.cliModel !== freshTurn.cliModel) {
              debug(`provider: persistent setModel ${queryCtx.cliModel} → ${freshTurn.cliModel}`);
              await activeQuery.setModel(freshTurn.cliModel);
              queryCtx.cliModel = freshTurn.cliModel;
            }
            inputQueue.push(promptMessage);
            debug(
              `Case 3: pushed turn into persistent session ${doppel.session?.sessionId.slice(0, 8) ?? "unknown"} (doppel=${doppel.label})`,
            );
          } catch (error) {
            if (!queryCtx.closing) failQuery(queryCtx, "error", errorMessage(error), "rebuild");
          }
        })();
        return;
      }

      spawnTurn({
        queryCtx,
        freshTurn,
        syncPlan,
        promptMessage,
        persistent,
        drainExisting: warmQuery,
      });
    }

    beginTurn(0);
    return stream;
  }

  // Full session reset for pi lifecycle events (session start/shutdown). Closes every
  // doppel's query — the host's is drained when it is idle, everyone else's abandoned —
  // and drops all session state + the store. The caller (index.ts) owns the
  // provider-registration global and clears it separately.
  async function clear(reason: string): Promise<void> {
    debug(
      `${reason}: clearing ${
        doppels
          .all()
          .map((doppel) => doppel.label)
          .join(", ") || "no doppels"
      }`,
    );
    const contexts = [...activeQueryContexts];
    await Promise.all(
      contexts.map((context) =>
        closeQueryContext(
          context,
          reason,
          context.doppel.kind === "host" && context.readyForInput ? "drain" : "force",
        ),
      ),
    );
    doppels.clear();
    sessionStore.clear();
  }

  // Provider switch: close the persistent query but keep the shared session/store.
  function closePersistent(reason: string): Promise<void> {
    return closePersistentQuery(reason);
  }

  // pi /compact and session-tree navigation (rewind / fork-at-point / branch
  // switch) both mutate pi's messages array out from under the bridge — always the
  // hosting session's. The sync REUSE check would otherwise keep --resume'ing a CC
  // session that no longer matches pi's history. Force the next call down the
  // REBUILD path so CC sees the current history.
  async function markRebuild(reason: string): Promise<void> {
    if (doppels.hostKey === null) return;
    const hostDoppel = doppels.host();
    if (!hostDoppel.session) return;
    debug(
      `${reason}: marking rebuild on ${hostDoppel.label} session ${hostDoppel.session.sessionId.slice(0, 8)}`,
    );
    await closePersistentQuery(reason);
    // The close above runs a turn-complete write-back that would drop the flag, so the
    // mark lands after it, on whatever session state that left behind.
    const marked = hostDoppel.session;
    if (marked) hostDoppel.session = { ...marked, rebuildReason: reason };
  }

  // pi names the session hosting this process at session_start. The outgoing host keeps
  // its state as a guest, but not its warm query: pushing another conversation's turn
  // into it would continue the wrong transcript.
  async function designateHost(piSessionId: string): Promise<void> {
    if (doppels.hostKey === piSessionId) return;
    const { host: hostDoppel, demoted } = doppels.designate(piSessionId);
    debug(`provider: host designated ${hostDoppel.label}`);
    if (!demoted) return;
    debug(`provider: previous host demoted to ${demoted.label}`);
    await closeQueryContext(
      demoted.context,
      `host re-designation → ${hostDoppel.label}`,
      demoted.context.readyForInput ? "drain" : "force",
    );
  }

  return {
    turn: (request: RuntimeRequest) => run({ ...request, explicitReplay: false }),
    replay: (request: RuntimeRequest) => run({ ...request, explicitReplay: true }),
    clear,
    closePersistent,
    markRebuild,
    designateHost,
    // @internal — surface for tests that exercise session sync and MCP routing
    // by instantiating the factory directly (no extension activation).
    test: {
      doppels,
      get hostContext() {
        return doppels.host().context;
      },
      resetSessions() {
        doppels.clear();
        sessionStore.clear();
      },
      setHostSession(state: SessionState | null) {
        doppels.host().session = state;
      },
      getHostSession() {
        return doppels.host().session;
      },
      getStoredSession(sessionId: string) {
        return sessionStore.load(sessionId);
      },
      syncHostSession(messages: MessageParam[], cwd: string, modelId?: string) {
        const hostDoppel = doppels.host();
        return applySessionSync({
          doppel: hostDoppel,
          plan: planSessionSync(messages, hostDoppel.session),
          cwd,
          sessionStore,
          modelId,
        });
      },
      consumeQuery,
      finalizeCurrentResponse,
      emitTerminalError,
      closeQueryContext,
      settleInterruptedQuery,
      createMcpToolHandler,
      buildMcpServers,
      run,
    },
  };
}
