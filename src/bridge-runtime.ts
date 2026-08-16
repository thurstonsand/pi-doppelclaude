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
import type {
  Base64ImageSource,
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources";
import {
  type Api,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
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
import { messageContentToText } from "./convert.js";
import { isDeadQueryFailure } from "./dead-query.js";
import { debug, diagDump } from "./debug.js";
import { FALLBACK_TOOL_DESCRIPTION_CAP } from "./description-cap.js";
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
import {
  extractAllToolResults as _extractAllToolResults,
  type McpResult,
} from "./extract-tool-results.js";
import type { BridgeModelCatalog } from "./model-catalog.js";
import { createProviderStreamRuntime } from "./provider-stream.js";
import { PushQueue, type QueryContext } from "./query-state.js";
import type { RefusalEntryData } from "./refusal.js";
import { awaitQueryInitialization, reconcileMcpServers } from "./sdk-signals.js";
import { BridgeSessionStore, MalformedSessionTranscriptError } from "./session-store.js";
import type { ProviderSettings } from "./settings.js";
import { MCP_SERVER_NAME } from "./skills.js";
import { mcpSignature, planTurn, resolveMcpTools } from "./turn-plan.js";

export interface BridgeRuntimeDependencies {
  providerSettings: ProviderSettings;
  queryFactory?(request: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
  sessionStore?: BridgeSessionStore;
  /** Absent in tests that exercise streaming without a provider; then a served model teaches nothing. */
  modelCatalog?: BridgeModelCatalog;
  getToolDescriptionCap?(): number | false;
}

/**
 * What the runtime needs from Pi while a session is open. `ui` comes from the session event and
 * `appendEntry` from the extension API, gathered into one surface the runtime holds or drops as a
 * unit and the owning activation refreshes on each `session_start`.
 */
export interface BridgeHost {
  ui: ExtensionUIContext;
  appendEntry(customType: string, data: RefusalEntryData): void;
}

/** The spawn-shaped half of a turn: what a fresh subprocess is given, derived from the
 *  request alone, plus the MCP server bound to the context that will run it. */
interface FreshTurn {
  mcpTools: Tool[];
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
  model: Model<Api>;
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

export function createBridgeRuntime(dependencies: BridgeRuntimeDependencies) {
  const { providerSettings } = dependencies;
  const queryFactory = dependencies.queryFactory ?? query;
  const getToolDescriptionCap =
    dependencies.getToolDescriptionCap ??
    (() => providerSettings.toolDescriptionCap ?? FALLBACK_TOOL_DESCRIPTION_CAP);

  const doppels = createDoppelRegistry();
  const sessionStore = dependencies.sessionStore ?? new BridgeSessionStore(debug);
  let host: BridgeHost | null = null;
  const activeQueryContexts = new Set<QueryContext>();

  const {
    claimCurrentPiStream,
    emitTerminalError,
    finalizeCurrentStream,
    replayBufferedSdkMessages,
    consumeQuery,
  } = createProviderStreamRuntime({
    debug,
    notify: (message, level) => host?.ui.notify(message, level),
    appendEntry: (customType, data) => host?.appendEntry(customType, data),
    observeServedModel: (id) => {
      dependencies.modelCatalog
        ?.noteServedModel(id)
        .catch((error) => debug("provider: recording the served model failed", error));
    },
  });

  // Pi doesn't pass tool results directly — it appends them to the context and calls
  // the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
  // debug logging at the extraction boundary.
  function extractAllToolResults(context: Context): McpResult[] {
    const { results, stopIdx } = _extractAllToolResults(
      context.messages as unknown as Array<{
        role: string;
        [key: string]: unknown;
      }>,
    );
    debug(
      `extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`,
    );
    debug(
      `extractAllToolResults: all msg roles:`,
      context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
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
  function extractUserPrompt(messages: Context["messages"]): string | null {
    const last = messages[messages.length - 1];
    if (last?.role !== "user") return null;
    if (typeof last.content === "string") return last.content;
    return messageContentToText(last.content) || "";
  }

  /** Extract the last user message as ContentBlockParam[] (preserving images).
   *  Returns null if no images — caller should fall back to string prompt. */
  function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
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
      } else if (block.type === "image") {
        debug(
          `image block: mimeType=${block.mimeType}, data length=${block.data.length}, keys=${Object.keys(block).join(",")}`,
        );
        if (!block.data || !block.mimeType) {
          debug(`image block missing data or mimeType, skipping`);
          continue;
        }
        hasImage = true;
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType as Base64ImageSource["media_type"],
            data: block.data,
          },
        });
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
    return sdkPrompt(blocks ?? text ?? "[continue]");
  }

  function contextForToolResults(results: McpResult[]): QueryContext | undefined {
    for (const result of results) {
      const id = result.toolCallId;
      if (!id) continue;
      for (const queryCtx of activeQueryContexts) {
        if (
          queryCtx.pendingToolCalls.has(id) ||
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

  function failMcpBridge(queryCtx: QueryContext): void {
    const message =
      "Claude bridge incompatible with this Claude Code version: CLI no longer sends claudecode/toolUseId in MCP tool metadata";
    debug(`provider: fatal MCP bridge error: ${message}`);
    host?.ui.notify(message, "error");
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
      return new Promise<McpResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, { toolName, resolve });
      });
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
  function advertisedInputSchema(tool: Tool): { type: "object" } {
    const schemaType = (tool.parameters as { type?: unknown }).type;
    if (schemaType !== "object")
      throw new Error(
        `Claude bridge: tool ${tool.name} parameters must be an object schema, got ${JSON.stringify(schemaType)}`,
      );
    // pi types parameters as TSchema, which hides `type`; the check above proves
    // the literal MCP requires.
    return tool.parameters as { type: "object" };
  }

  function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, McpServerConfig> {
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
      doppel.session = { ...doppel.session, needsRebuild: true };
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
    for (const pending of c.pendingToolCalls.values())
      pending.resolve({ content: [{ type: "text", text: "Query ended" }] });
    c.pendingToolCalls.clear();
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
    c.currentPiStream = null;
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
      doppel.session = { ...doppel.session, needsRebuild: true };
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
      customToolNameToSdk,
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
        customToolNameToSdk,
        modelId: model.id,
      });
      queryCtx.pendingToolCalls.clear();
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
            finalizeCurrentStream(queryCtx);
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
          host?.ui.notify(`Claude transcript mirror failed: ${message.error}`, "error");
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

  /** Provider entry point. Pi calls this for each new prompt and each tool result. */
  function streamClaudeAgentSdk(
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const lastMsg = context.messages[context.messages.length - 1];
    const lastMsgRole = lastMsg?.role;
    debug(
      `provider: streamClaudeAgentSdk called, sessionId=${options?.sessionId?.slice(0, 8) ?? "none"}, lastMsgRole=${lastMsgRole}`,
    );

    /** Wires pi's abort signal for this call to the query that answers it. */
    function attachAbortTo(queryCtx: QueryContext): void {
      queryCtx.abortCleanup?.();
      if (!options?.signal) return;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        queryCtx.turnAborted = true;
        queryCtx.readyForInput = false;
        for (const pending of queryCtx.pendingToolCalls.values())
          pending.resolve({
            content: [{ type: "text", text: "Operation aborted" }],
          });
        queryCtx.pendingToolCalls.clear();
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
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
      queryCtx.abortCleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };
    }

    function planFreshTurn(queryCtx: QueryContext, persistent: boolean): FreshTurn {
      const toolDescriptionCap = getToolDescriptionCap();
      const { mcpTools, originalMcpTools, relocations, customToolNameToSdk, customToolNameToPi } =
        resolveMcpTools(context, toolDescriptionCap);
      const { cwd, cliModel, spawnSignature, queryOptions } = planTurn({
        model,
        context,
        options,
        providerSettings,
        oneShot: !persistent,
        relocations,
      });
      return {
        mcpTools,
        customToolNameToSdk,
        customToolNameToPi,
        cwd,
        cliModel,
        spawnSignature,
        mcpSignature: mcpSignature(originalMcpTools),
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
        contextMessageCount: context.messages.length,
        persistent: request.persistent,
        drainExisting: request.drainExisting,
        promptMessage: request.promptMessage,
        attachAbort: () => attachAbortTo(request.queryCtx),
      });
    }

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
      debug(
        `provider: tool results, ${allResults.length} results, ${resultCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`,
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
        const steering = lastMsgRole === "user";
        debug(
          `provider: replaying the tool-result continuation on a fresh subprocess (doppel=${doppel.label}, ${allResults.length} result(s) already in pi's history, prompt=${steering ? "steering" : "replay"}, persistent=${persistent})`,
        );
        claimCurrentPiStream(stream, "tool-result-replay", queryCtx);
        queryCtx.activeModel = model;
        queryCtx.restartTurnState(model);
        queryCtx.fatalError = null;
        spawnTurn({
          queryCtx,
          freshTurn: planFreshTurn(queryCtx, persistent),
          syncPlan: steering
            ? planSessionSync(context.messages, doppel.session)
            : planReplaySync(context.messages, doppel.session),
          promptMessage: steering ? sdkUserMessage(context.messages) : sdkPrompt(REPLAY_PROMPT),
          persistent,
          drainExisting: false,
        });
      };

      if (lastMsgRole === "user") {
        if (resultCtx.persistent && resultCtx.inputQueue) {
          resultCtx.inputQueue.push(sdkUserMessage(context.messages));
          debug(
            `provider: queued native steering message: ${extractUserPrompt(context.messages)?.slice(0, 60) ?? "[image]"}`,
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
        const pending = resultCtx.pendingToolCalls.get(id);
        if (pending) {
          resultCtx.pendingToolCalls.delete(id);
          debug(
            `provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`,
            JSON.stringify(result.content).slice(0, 200),
          );
          pending.resolve(result);
        } else if (resultCtx.rejectedToolCallIds.has(id)) {
          // Claude Code already answered this call with its own error; a second
          // answer would be a duplicate reply to a closed question.
          debug(`provider: dropping result for Claude-rejected call [${id}]`);
        } else if (resultCtx.shownToolCallIds.has(id)) {
          resultCtx.pendingResults.set(id, result);
          debug(`provider: queued result [${id}] (${resultCtx.pendingResults.size} pending)`);
        } else {
          emitTerminalError(
            resultCtx,
            "error",
            `Claude bridge: pi delivered a result for tool call [${id}], which was never streamed to pi`,
          );
          return stream;
        }
      }
      if (resultCtx.pendingToolCalls.size > 0) {
        const waiting = [...resultCtx.pendingToolCalls.keys()].join(", ");
        emitTerminalError(
          resultCtx,
          "error",
          `Claude bridge: ${resultCtx.pendingToolCalls.size} tool handler(s) still waiting after ${allResults.length} result(s) [${waiting}]`,
        );
        return stream;
      }
      if (resultCtx.doppel.session) resultCtx.doppel.session.cursor = context.messages.length;
      return stream;
    }

    if (lastMsgRole === "toolResult") {
      debug("provider: orphaned tool result after abort, emitting end_turn");
      const doppel = doppels.resolve(options?.sessionId);
      const orphanCtx = doppel.context;
      if (doppel.session) doppel.session.cursor = context.messages.length;
      claimCurrentPiStream(stream, "orphan-tool-result", orphanCtx);
      if (orphanCtx.fatalError) {
        emitTerminalError(orphanCtx, "error", orphanCtx.fatalError);
        return stream;
      }
      queueMicrotask(() => {
        orphanCtx.resetTurnState(model);
        // Deliberate completion, not a streamed one: no SDK query runs here, so the
        // acknowledgement has to name its own terminal state or finalize reads it
        // as a turn that died mid-stream.
        if (orphanCtx.turnOutput) orphanCtx.turnOutput.stopReason = "stop";
        finalizeCurrentStream(orphanCtx);
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
      const doppel = doppels.resolve(options?.sessionId);
      const primary = doppel.context;
      const warmQuery = Boolean(primary.activeQuery && primary.persistent && primary.readyForInput);
      // Reentrancy proper: a turn arrived while this doppel's query is mid-flight.
      const isReentrant = Boolean(primary.activeQuery && !warmQuery);
      const queryCtx = isReentrant ? doppel.spawnContext() : primary;
      const persistent = !isReentrant && doppel.kind === "host";
      const syncPlan = planSessionSync(context.messages, doppel.session);
      const promptMessage = sdkUserMessage(context.messages);
      const freshTurn = planFreshTurn(queryCtx, persistent);

      const canPush = Boolean(
        warmQuery &&
          !isReentrant &&
          syncPlan.path === "reuse" &&
          queryCtx.spawnSignature === freshTurn.spawnSignature,
      );

      claimCurrentPiStream(stream, canPush ? "persistent-reuse" : "fresh-query", queryCtx);
      queryCtx.activeModel = model;
      queryCtx.beginCommand(model);
      // Installed after beginCommand, which clears it. Exactly one replay per turn: the
      // second attempt arms nothing, so a retry that dies the same way is reported.
      queryCtx.turnRetry = attempt === 0 ? () => beginTurn(attempt + 1) : null;
      queryCtx.latestCursor = Math.max(queryCtx.latestCursor, context.messages.length);
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
          customToolNameToSdk: freshTurn.customToolNameToSdk,
          modelId: model.id,
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
      `${reason}: marking needsRebuild on ${hostDoppel.label} session ${hostDoppel.session.sessionId.slice(0, 8)}`,
    );
    await closePersistentQuery(reason);
    hostDoppel.session = { ...hostDoppel.session, needsRebuild: true };
  }

  function setHost(next: BridgeHost | null): void {
    host = next;
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
    stream: streamClaudeAgentSdk,
    clear,
    closePersistent,
    markRebuild,
    setHost,
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
      syncHostSession(
        messages: Context["messages"],
        cwd: string,
        customToolNameToSdk?: Map<string, string>,
        modelId?: string,
      ) {
        const hostDoppel = doppels.host();
        return applySessionSync({
          doppel: hostDoppel,
          plan: planSessionSync(messages, hostDoppel.session),
          cwd,
          sessionStore,
          customToolNameToSdk,
          modelId,
        });
      },
      consumeQuery,
      finalizeCurrentStream,
      emitTerminalError,
      closeQueryContext,
      settleInterruptedQuery,
      createMcpToolHandler,
      buildMcpServers,
      streamClaudeAgentSdk,
    },
  };
}
