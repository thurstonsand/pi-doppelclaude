import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type ModelInfo, query } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { type BridgeRuntimeDependencies, createBridgeRuntime } from "doppelclaude/bridge-runtime";
import type { CoreResponseEvent, CoreResponseRecord } from "doppelclaude/core-response";
import { canonicalClaudeModelId } from "doppelclaude/model-id";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { sdkChildEnv } from "doppelclaude/sdk-child-env";
import { prepareToolDescriptions } from "doppelclaude/tool-description-relocation";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const THREAD_LINE =
  /^Amp Thread URL: https:\/\/ampcode\.com\/threads\/(T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\r?$/gm;
const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
const DEFAULT_RUNTIME_LIMIT = 32;
const DEFAULT_IDLE_TTL = 3_600_000;
const DEFAULT_REQUEST_TIMEOUT = 600_000;
const DEFAULT_SHUTDOWN_TIMEOUT = 15_000;
const CacheControl = Type.Optional(Type.Record(Type.String(), Type.Unknown()));
const TextBlock = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  cache_control: CacheControl,
});
const ImageBlock = Type.Object({
  type: Type.Literal("image"),
  source: Type.Object({
    type: Type.Literal("base64"),
    media_type: Type.Union([
      Type.Literal("image/jpeg"),
      Type.Literal("image/png"),
      Type.Literal("image/gif"),
      Type.Literal("image/webp"),
    ]),
    data: Type.String(),
  }),
  cache_control: CacheControl,
});
const ThinkingBlock = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  signature: Type.String(),
});
const ToolUseBlock = Type.Object({
  type: Type.Literal("tool_use"),
  id: Type.String(),
  name: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
  cache_control: CacheControl,
});
const ToolResultBlock = Type.Object({
  type: Type.Literal("tool_result"),
  tool_use_id: Type.String(),
  content: Type.Union([Type.String(), Type.Array(Type.Union([TextBlock, ImageBlock]))]),
  is_error: Type.Optional(Type.Boolean()),
  cache_control: CacheControl,
});
const ContentBlock = Type.Union([
  TextBlock,
  ImageBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
]);
const Message = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  content: Type.Union([Type.String(), Type.Array(ContentBlock)]),
});
const RequestSchema = Type.Object(
  {
    model: Type.String(),
    max_tokens: Type.Integer({ minimum: 1 }),
    messages: Type.Array(Message),
    system: Type.Optional(Type.Union([Type.String(), Type.Array(TextBlock)])),
    tools: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String(),
            description: Type.Optional(Type.String()),
            input_schema: Type.Object(
              { type: Type.Literal("object") },
              { additionalProperties: true },
            ),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    stream: Type.Optional(Type.Boolean()),
    temperature: Type.Optional(Type.Number()),
    tool_choice: Type.Optional(
      Type.Union([
        Type.Object({ type: Type.Literal("auto") }, { additionalProperties: false }),
        Type.Object({ type: Type.Literal("none") }, { additionalProperties: false }),
      ]),
    ),
    thinking: Type.Optional(
      Type.Union([
        Type.Object(
          {
            type: Type.Literal("adaptive"),
            display: Type.Optional(Type.Literal("summarized")),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            type: Type.Literal("enabled"),
            budget_tokens: Type.Integer({ minimum: 1024 }),
            display: Type.Optional(Type.Literal("summarized")),
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    output_config: Type.Optional(
      Type.Object(
        {
          effort: Type.Union([
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("max"),
          ]),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type ApiRequest = Static<typeof RequestSchema>;
type Runtime = ReturnType<typeof createBridgeRuntime>;
interface ThreadState {
  runtime: Runtime;
  busy: boolean;
  calls: Map<string, CallRecord>;
  pendingTool: boolean;
  expectedHistory: MessageParam[];
  requestSignature?: string;
  forceRebuild: boolean;
  lastActivity: number;
}
interface CallRecord {
  sdkId: string;
  name: string;
  input: unknown;
}

export interface HttpServerOptions {
  apiKey: string;
  supportedModels: readonly ModelInfo[];
  maxBodyBytes?: number;
  maxRuntimes?: number;
  idleTtlMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  stateDir?: string;
  now?: () => number;
  retryAttempts?: number;
  retryDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
  toolDescriptionCap?: number | false;
  queryFactory?: BridgeRuntimeDependencies["queryFactory"];
  createRuntime?: (threadId: string) => Runtime;
}

export interface HttpEnvironmentConfig {
  apiKey: string;
  host: string;
  port: number;
  stateDir: string;
  maxRuntimes: number;
  idleTtlMs: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  shutdownTimeoutMs: number;
  retryAttempts: number;
}

export interface HttpModel {
  id: string;
  type: "model";
  display_name: string;
  created_at: null;
}

const STABLE_CLAUDE_MODEL = /^claude-[a-z][a-z0-9]*-\d+(?:-\d+)*$/u;
const REQUEST_MODEL_ALIASES = ["opus", "fable"];

function snapshotModelAliases(models: readonly ModelInfo[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const alias of REQUEST_MODEL_ALIASES) {
    const exact = models.find(
      (model) =>
        model.value === alias &&
        model.resolvedModel !== undefined &&
        STABLE_CLAUDE_MODEL.test(model.resolvedModel),
    )?.resolvedModel;
    if (exact) {
      aliases.set(alias, exact);
      continue;
    }

    const familyPrefix = `claude-${alias}-`;
    const candidates = new Set<string>();
    for (const row of models) {
      const concrete = row.resolvedModel ?? row.value;
      if (STABLE_CLAUDE_MODEL.test(concrete) && concrete.startsWith(familyPrefix)) {
        candidates.add(concrete);
      }
    }
    if (candidates.size === 1) aliases.set(alias, candidates.values().next().value as string);
  }
  return aliases;
}

function requestModelId(model: string, aliases: ReadonlyMap<string, string>): string | undefined {
  const parts = model.split("/");
  const bare =
    parts.length === 1
      ? parts[0]
      : parts.length === 2 && parts[0].length > 0
        ? parts[1]
        : undefined;
  if (!bare) return undefined;
  if (STABLE_CLAUDE_MODEL.test(bare)) return bare;
  if (REQUEST_MODEL_ALIASES.includes(bare)) {
    const resolved = aliases.get(bare);
    if (!resolved) {
      throw new RequestError(
        `model alias ${bare} is unavailable: startup model catalog did not identify exactly one stable Claude model ID`,
      );
    }
    return resolved;
  }
  return undefined;
}

export function projectHttpModels(models: readonly ModelInfo[]): HttpModel[] {
  const projected = new Map<string, HttpModel>();
  for (const model of models) {
    for (const advertised of [model.resolvedModel, model.value]) {
      if (!advertised) continue;
      const id = canonicalClaudeModelId(advertised);
      if (!STABLE_CLAUDE_MODEL.test(id) || projected.has(id)) continue;
      projected.set(id, {
        id,
        type: "model",
        display_name: model.displayName,
        created_at: null,
      });
    }
  }
  return [...projected.values()];
}

class RequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
class StreamError extends Error {
  constructor(
    message: string,
    readonly retryableStatus: 429 | 529 | undefined,
    readonly emitted: boolean,
  ) {
    super(message);
  }
}
function errorResponse(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
  );
}
function extractThread(system: ApiRequest["system"]): { threadId: string; prompt: string } {
  const texts = typeof system === "string" ? [system] : (system ?? []).map((block) => block.text);
  const matches = texts.flatMap((text) => [...text.matchAll(THREAD_LINE)].map((match) => match[1]));
  if (matches.length !== 1)
    throw new RequestError("system must contain exactly one Amp Thread URL line");
  return { threadId: matches[0], prompt: texts.join("\n") };
}
function stripBlockCaches(messages: ApiRequest["messages"]): MessageParam[] {
  const copy = structuredClone(messages) as Array<Record<string, unknown>>;
  for (const message of copy) {
    delete message.cache_control;
    if (Array.isArray(message.content))
      for (const raw of message.content) {
        const block = raw as Record<string, unknown>;
        delete block.cache_control;
        if (block.type === "tool_result" && Array.isArray(block.content))
          for (const nested of block.content)
            delete (nested as Record<string, unknown>).cache_control;
      }
  }
  return copy as unknown as MessageParam[];
}
function canonicalHistory(messages: MessageParam[]): string {
  const copy = structuredClone(messages) as Array<{ role: string; content: unknown }>;
  const ids = new Map<string, string>();
  let assistant = 0;
  for (const message of copy) {
    if (Array.isArray(message.content)) {
      let call = 0;
      for (const raw of message.content) {
        const block = raw as Record<string, unknown>;
        delete block.cache_control;
        if (block.type === "text") delete block.citations;
        if (block.type === "tool_result" && Array.isArray(block.content))
          for (const nested of block.content) {
            const content = nested as Record<string, unknown>;
            delete content.cache_control;
            if (content.type === "text") delete content.citations;
          }
        if (message.role === "assistant" && block.type === "tool_use") {
          const canonical = `call:${assistant}:${call++}`;
          ids.set(String(block.id), canonical);
          block.id = canonical;
        }
      }
      if (message.role === "user") {
        for (const raw of message.content) {
          const block = raw as Record<string, unknown>;
          if (block.type === "tool_result")
            block.tool_use_id = ids.get(String(block.tool_use_id)) ?? block.tool_use_id;
        }
        const results = message.content
          .filter((raw) => (raw as Record<string, unknown>).type === "tool_result")
          .sort((left, right) =>
            String((left as Record<string, unknown>).tool_use_id).localeCompare(
              String((right as Record<string, unknown>).tool_use_id),
            ),
          );
        let result = 0;
        message.content = message.content.map((raw) =>
          (raw as Record<string, unknown>).type === "tool_result" ? results[result++] : raw,
        );
      }
    }
    if (message.role === "assistant") assistant++;
  }
  return JSON.stringify(copy);
}
function validateMessages(messages: ApiRequest["messages"]): void {
  if (messages.length === 0) throw new RequestError("messages must not be empty");
  for (const [index, message] of messages.entries()) {
    if (typeof message.content === "string") {
      if (!message.content) throw new RequestError(`message ${index} content must not be empty`);
      continue;
    }
    if (message.content.length === 0)
      throw new RequestError(`message ${index} content must not be empty`);
    for (const block of message.content) {
      const allowed =
        message.role === "assistant"
          ? block.type === "text" || block.type === "thinking" || block.type === "tool_use"
          : block.type === "text" || block.type === "image" || block.type === "tool_result";
      if (!allowed) throw new RequestError(`${block.type} is invalid in a ${message.role} message`);
    }
  }
  if (messages.at(-1)?.role !== "user") throw new RequestError("last message must have role user");
}
function normalizeMessages(
  messages: ApiRequest["messages"],
  priorCalls: Map<string, CallRecord>,
  toolNameToSdk: Map<string, string>,
): { messages: MessageParam[]; calls: Map<string, CallRecord> } {
  const calls = new Map<string, CallRecord>();
  const clientToSdk = new Map<string, string>();
  let assistant = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      if (message.role === "assistant") assistant++;
      continue;
    }
    let call = 0;
    for (const block of message.content)
      if (block.type === "tool_use") {
        if (clientToSdk.has(block.id)) throw new RequestError(`duplicate tool_use id: ${block.id}`);
        const position = `${assistant}:${call++}`;
        const prior = priorCalls.get(position);
        if (
          prior &&
          (prior.name !== block.name || JSON.stringify(prior.input) !== JSON.stringify(block.input))
        )
          throw new RequestError(`tool_use changed at assistant position ${position}`);
        const sdkId = prior?.sdkId ?? block.id;
        calls.set(position, { sdkId, name: block.name, input: block.input });
        clientToSdk.set(block.id, sdkId);
      }
    assistant++;
  }
  const seenResults = new Set<string>();
  const normalized = stripBlockCaches(messages);
  assistant = 0;
  for (const message of normalized) {
    if (!Array.isArray(message.content)) {
      if (message.role === "assistant") assistant++;
      continue;
    }
    let call = 0;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        block.id = calls.get(`${assistant}:${call++}`)?.sdkId ?? block.id;
        block.name = toolNameToSdk.get(block.name) ?? block.name;
      }
      if (block.type === "tool_result") {
        if (seenResults.has(block.tool_use_id))
          throw new RequestError(`duplicate tool_result id: ${block.tool_use_id}`);
        seenResults.add(block.tool_use_id);
        const mapped = clientToSdk.get(block.tool_use_id);
        if (!mapped) throw new RequestError(`unknown tool_result id: ${block.tool_use_id}`);
        block.tool_use_id = mapped;
      }
    }
    if (message.role === "assistant") assistant++;
  }
  const allCalls = new Set(clientToSdk.keys());
  for (const id of seenResults) allCalls.delete(id);
  if (allCalls.size)
    throw new RequestError(`missing tool_result id: ${allCalls.values().next().value}`);
  return { messages: normalized, calls };
}
async function writeOutput(response: ServerResponse, value: string): Promise<void> {
  if (response.destroyed) throw new Error("client disconnected");
  if (response.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      response.off("drain", drained);
      response.off("close", closed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const closed = () => {
      cleanup();
      reject(new Error("client disconnected"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("client output stalled"));
    }, 30_000);
    timer.unref();
    response.once("drain", drained);
    response.once("close", closed);
  });
}
async function sse(response: ServerResponse, event: string, data: unknown): Promise<void> {
  await writeOutput(response, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
async function writeStream(
  response: ServerResponse,
  source: AsyncIterable<CoreResponseEvent>,
  state: ThreadState,
  assistantOrdinal: number,
): Promise<CoreResponseRecord> {
  let final: CoreResponseRecord | undefined;
  let stopped = false;
  let emitted = false;
  for await (const event of source) {
    if (event.type === "terminal_error") {
      throw new StreamError(event.message, event.retryableStatus, emitted);
    }
    if (event.type === "response") {
      final = event.response;
      continue;
    }
    if (event.type === "message_stop") {
      stopped = true;
      continue;
    }
    await sse(response, event.type, event);
    emitted = true;
  }
  if (!final) throw new Error("bridge stream ended without a native response record");
  if (stopped) await sse(response, "message_stop", { type: "message_stop" });
  let ordinal = 0;
  for (const block of final.message.content)
    if (block.type === "tool_use")
      state.calls.set(`${assistantOrdinal}:${ordinal++}`, {
        sdkId: block.id,
        name: block.name,
        input: block.input,
      });
  return final;
}
async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new RequestError("request body too large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("request body is not valid JSON");
  }
}

export function createHttpServer(options: HttpServerOptions): Server {
  if (!options.apiKey.trim()) throw new Error("HTTP spike API key must not be blank");
  const catalog = projectHttpModels(options.supportedModels);
  const modelAliases = snapshotModelAliases(options.supportedModels);
  const stateDir = options.stateDir ?? join(homedir(), ".local/state/doppelclaude");
  if (!stateDir.trim()) throw new Error("state directory must not be blank");
  const states = new Map<string, ThreadState>();
  const closing = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  const aborts = new Set<AbortController>();
  const now = options.now ?? Date.now;
  let shuttingDown = false;
  let shutdown: Promise<Error | undefined> | undefined;
  let registryTail = Promise.resolve();
  const registry = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    const prior = registryTail;
    let release!: () => void;
    registryTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const beginClose = (key: string, state: ThreadState, reason: string): Promise<void> => {
    const promise = Promise.resolve(state.runtime.clear(reason))
      .catch((error) => {
        process.stderr.write(`[http-doppelclaude] runtime close failed: ${String(error)}\n`);
      })
      .then(() => {
        if (closing.get(key) === promise) closing.delete(key);
      });
    closing.set(key, promise);
    return promise;
  };
  const makeRuntime = (threadId: string) => {
    const runtime =
      options.createRuntime?.(threadId) ??
      createBridgeRuntime({ queryFactory: options.queryFactory ?? query });
    void runtime.designateHost(threadId);
    return runtime;
  };
  const waitForClose = async (promise: Promise<void>): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new RequestError("runtime capacity reached", 503)),
            options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const server = createServer(async (request, response) => {
    const auth = request.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const supplied =
      typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : bearer;
    if (supplied !== options.apiKey) {
      errorResponse(response, 401, "invalid API key");
      return;
    }
    if (request.url === "/v1/models" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          data: catalog,
          has_more: false,
          first_id: catalog.at(0)?.id ?? null,
          last_id: catalog.at(-1)?.id ?? null,
        }),
      );
      return;
    }
    if (request.url !== "/v1/messages" || request.method !== "POST") {
      errorResponse(response, 404, "not found");
      return;
    }
    if (shuttingDown) {
      errorResponse(response, 503, "server is shutting down");
      return;
    }
    let state: ThreadState | undefined;
    let locked = false;
    let disconnected = false;
    let abort: AbortController | undefined;
    let reservationKey: string | undefined;
    let ownsReservation = false;
    let markDisconnected = () => {};
    let responseClosed = () => {};
    try {
      const value = await readBody(request, options.maxBodyBytes ?? DEFAULT_BODY_LIMIT);
      if (shuttingDown) throw new RequestError("server is shutting down", 503);
      if (!Value.Check(RequestSchema, value)) {
        const error = Value.Errors(RequestSchema, value)[0];
        throw new RequestError(
          error
            ? `schema validation failed at ${error.instancePath || "/"}: ${error.message}; params=${JSON.stringify(error.params)}`
            : "invalid request",
        );
      }
      const body = value as ApiRequest;
      validateMessages(body.messages);
      if (body.stream !== true) throw new RequestError("only stream: true is supported");
      if (body.temperature !== undefined) throw new RequestError("temperature is unsupported");
      const model = requestModelId(body.model, modelAliases);
      if (!model)
        throw new RequestError("model must be a stable Claude model ID or <provider>/<model>");
      const { threadId, prompt } = extractThread(body.system);
      reservationKey = threadId;
      // Validate history references before reserving scarce process capacity. Tool names are mapped
      // again below once request tools have been prepared.
      normalizeMessages(body.messages, new Map(), new Map());
      let eviction: Promise<void> | undefined;
      state = await registry(() => {
        if (shuttingDown) throw new RequestError("server is shutting down", 503);
        if (closing.has(threadId) || pending.has(threadId))
          throw new RequestError("another request for this Amp thread is active", 409);
        const existing = states.get(threadId);
        if (existing) {
          if (existing.busy)
            throw new RequestError("another request for this Amp thread is active", 409);
          existing.busy = true;
          return existing;
        }
        pending.add(threadId);
        ownsReservation = true;
        if (
          states.size + closing.size + pending.size >
          (options.maxRuntimes ?? DEFAULT_RUNTIME_LIMIT)
        ) {
          const idle = [...states.entries()]
            .filter(([, candidate]) => !candidate.busy)
            .sort((left, right) => left[1].lastActivity - right[1].lastActivity)[0];
          if (!idle) {
            pending.delete(threadId);
            throw new RequestError("runtime capacity reached", 503);
          }
          states.delete(idle[0]);
          eviction = beginClose(idle[0], idle[1], "HTTP runtime capacity eviction");
        }
        if (eviction) return undefined;
        try {
          const created: ThreadState = {
            runtime: makeRuntime(threadId),
            busy: true,
            calls: new Map(),
            pendingTool: false,
            expectedHistory: [],
            forceRebuild: false,
            lastActivity: now(),
          };
          pending.delete(threadId);
          ownsReservation = false;
          states.set(threadId, created);
          return created;
        } catch (error) {
          pending.delete(threadId);
          throw error;
        }
      });
      if (!state && eviction) {
        try {
          await waitForClose(eviction);
          state = await registry(() => {
            if (shuttingDown) throw new RequestError("server is shutting down", 503);
            if (!pending.has(threadId))
              throw new RequestError("another request for this Amp thread is active", 409);
            if (
              states.size + closing.size + pending.size >
              (options.maxRuntimes ?? DEFAULT_RUNTIME_LIMIT)
            )
              throw new RequestError("runtime capacity reached", 503);
            const created: ThreadState = {
              runtime: makeRuntime(threadId),
              busy: true,
              calls: new Map(),
              pendingTool: false,
              expectedHistory: [],
              forceRebuild: false,
              lastActivity: now(),
            };
            pending.delete(threadId);
            states.set(threadId, created);
            return created;
          });
        } finally {
          pending.delete(threadId);
        }
      }
      if (!state) throw new RequestError("runtime capacity reached", 503);
      locked = true;
      const toolNameToSdk = new Map<string, string>();
      const toolNameToClient = new Map<string, string>();
      const rawTools =
        body.tool_choice?.type === "none" ? [] : (structuredClone(body.tools ?? []) as Tool[]);
      const prepared = prepareToolDescriptions(
        rawTools,
        prompt,
        options.toolDescriptionCap ?? false,
      );
      const tools = prepared.tools;
      for (const tool of tools) {
        const sdk = `mcp__custom-tools__${tool.name}`;
        toolNameToSdk.set(tool.name, sdk);
        toolNameToClient.set(sdk, tool.name);
      }
      const signature = JSON.stringify({
        prompt: prepared.systemPrompt,
        tools,
        toolChoice: body.tool_choice,
        effort: body.output_config?.effort,
        thinking: body.thinking,
        maxTokens: body.max_tokens,
      });
      const expectedPrior = body.messages.slice(0, -1) as MessageParam[];
      const historyDiverged =
        canonicalHistory(expectedPrior) !== canonicalHistory(state.expectedHistory);
      const signatureChanged =
        state.requestSignature !== undefined && state.requestSignature !== signature;
      const rebuild = state.forceRebuild || historyDiverged || signatureChanged;
      const normalized = normalizeMessages(
        body.messages,
        rebuild ? new Map() : state.calls,
        toolNameToSdk,
      );
      if (rebuild) {
        await state.runtime.markRebuild(
          state.forceRebuild
            ? "HTTP previous request failed"
            : signatureChanged
              ? "HTTP request settings changed"
              : "HTTP history diverged",
        );
      }
      state.forceRebuild = false;
      abort = new AbortController();
      aborts.add(abort);
      markDisconnected = () => {
        if (!disconnected) {
          disconnected = true;
          if (state) state.forceRebuild = true;
          abort?.abort();
        }
      };
      request.on("aborted", markDisconnected);
      responseClosed = () => {
        if (!response.writableEnded) markDisconnected();
      };
      response.on("close", responseClosed);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.flushHeaders();
      const heartbeat = setInterval(() => {
        if (!response.destroyed)
          void writeOutput(response, ": keepalive\n\n").catch(() => markDisconnected());
      }, 15_000);
      heartbeat.unref();
      const requestTimer = setTimeout(
        () => abort?.abort(new Error("request timeout")),
        options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
      );
      requestTimer.unref();
      const runtimeRequest: RuntimeRequest = {
        conversationKey: threadId,
        model,
        messages: normalized.messages,
        tools,
        systemPrompt: prepared.systemPrompt,
        effort: body.output_config?.effort,
        maxTokens: body.max_tokens,
        signal: abort.signal,
        cwd: process.cwd(),
        options: {
          tools: [],
          settingSources: [],
          thinking:
            body.thinking?.type === "enabled"
              ? { type: "enabled", budgetTokens: body.thinking.budget_tokens }
              : body.thinking
                ? { type: "adaptive" }
                : undefined,
          extraArgs: body.thinking?.display
            ? { "thinking-display": body.thinking.display }
            : undefined,
          env: sdkChildEnv({
            ENABLE_TOOL_SEARCH: "false",
            DISABLE_AUTO_COMPACT: "1",
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(body.max_tokens),
          }),
        },
        toolNameToSdk,
        toolNameToClient,
      };
      const last = normalized.messages.at(-1);
      const coldReplay =
        Array.isArray(last?.content) &&
        last.content.some((block) => block.type === "tool_result") &&
        (rebuild || !state.pendingTool);
      const assistantOrdinal = body.messages.filter(
        (message) => message.role === "assistant",
      ).length;
      state.calls = normalized.calls;
      let final: CoreResponseRecord;
      try {
        const attempts = options.retryAttempts ?? 2;
        let attempt = 0;
        for (;;) {
          abort.signal.throwIfAborted();
          try {
            final = await writeStream(
              response,
              coldReplay
                ? state.runtime.replay(runtimeRequest)
                : state.runtime.turn(runtimeRequest),
              state,
              assistantOrdinal,
            );
            break;
          } catch (error) {
            const retryable = error instanceof StreamError ? error.retryableStatus : undefined;
            if (
              (retryable !== 429 && retryable !== 529) ||
              !(error instanceof StreamError) ||
              error.emitted ||
              attempt >= attempts
            )
              throw error;
            attempt++;
            abort.signal.throwIfAborted();
            await state.runtime.markRebuild(`HTTP transient ${retryable} retry`);
            abort.signal.throwIfAborted();
            const delay =
              options.retryDelay ??
              ((n: number, signal: AbortSignal) =>
                sleep(250 * 2 ** (n - 1), undefined, { signal }));
            await delay(attempt, abort.signal);
            abort.signal.throwIfAborted();
          }
        }
      } finally {
        clearInterval(heartbeat);
        clearTimeout(requestTimer);
      }
      if (disconnected || response.destroyed) {
        state.forceRebuild = true;
        return;
      }
      state.pendingTool = final.message.stop_reason === "tool_use";
      state.expectedHistory = [
        ...(structuredClone(body.messages) as MessageParam[]),
        { role: "assistant", content: structuredClone(final.message.content) },
      ];
      state.requestSignature = signature;
      state.lastActivity = now();
      process.stderr.write(
        `[http-doppelclaude] thread=${threadId} sync=${rebuild ? "rebuild" : "reuse"} input=${final.message.usage.input_tokens} cache_read=${final.message.usage.cache_read_input_tokens ?? 0} output=${final.message.usage.output_tokens}\n`,
      );
      response.end();
    } catch (error) {
      if (ownsReservation && reservationKey) pending.delete(reservationKey);
      if (state && locked && !(error instanceof RequestError)) state.forceRebuild = true;
      const detail = (error instanceof Error ? error.message : String(error))
        .replaceAll(options.apiKey, "[REDACTED]")
        .replaceAll(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
        .replaceAll(/x-api-key["'\s:=]+[^\s,"';}]+/giu, "x-api-key: [REDACTED]")
        .replaceAll(/[\r\n]/gu, " ")
        .slice(0, 500);
      if (!disconnected && !response.headersSent)
        errorResponse(
          response,
          error instanceof RequestError ? error.status : 500,
          error instanceof RequestError ? error.message : "bridge failure",
        );
      else if (!disconnected && !response.writableEnded) {
        try {
          await sse(response, "error", {
            type: "error",
            error: { type: "api_error", message: detail },
          });
          response.end();
        } catch {
          // The client disconnected while the error event was under backpressure.
        }
      }
    } finally {
      if (abort) aborts.delete(abort);
      request.off("aborted", markDisconnected);
      response.off("close", responseClosed);
      if (state && locked) {
        state.busy = false;
        if (!shuttingDown) state.lastActivity = now();
      }
    }
  });
  const expiry = setInterval(
    () => {
      void registry(() => {
        if (shuttingDown) return;
        const cutoff = now() - (options.idleTtlMs ?? DEFAULT_IDLE_TTL);
        for (const [key, state] of states) {
          if (state.busy || state.lastActivity > cutoff) continue;
          states.delete(key);
          beginClose(key, state, "HTTP runtime idle expiry");
        }
      });
    },
    Math.min(options.idleTtlMs ?? DEFAULT_IDLE_TTL, 30_000),
  );
  expiry.unref();
  const close = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    if (shutdown) {
      void shutdown.then((error) =>
        callback?.(
          (error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING"
            ? undefined
            : error,
        ),
      );
      return server;
    }
    shuttingDown = true;
    clearInterval(expiry);
    for (const abort of aborts) abort.abort();
    const clearing = Promise.allSettled([
      ...closing.values(),
      ...[...states.entries()].map(([key, state]) =>
        beginClose(key, state, "HTTP server shutdown"),
      ),
    ]);
    let resolveShutdown!: (error: Error | undefined) => void;
    shutdown = new Promise<Error | undefined>((resolve) => {
      resolveShutdown = resolve;
    });
    let finished = false;
    let nativeError: Error | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      resolveShutdown(
        (nativeError as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING"
          ? undefined
          : nativeError,
      );
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT);
    deadline.unref();
    const nativeClosed = new Promise<void>((nativeDone) => {
      close((error?: Error) => {
        nativeError = error;
        nativeDone();
      });
    });
    server.closeIdleConnections();
    void Promise.all([nativeClosed, clearing]).then(finish);
    void shutdown.then((error) => callback?.(error));
    return server;
  }) as Server["close"];
  return server;
}

export async function apiKeyFromEnvironment(env = process.env): Promise<string> {
  if (
    env.DOPPELCLAUDE_HTTP_API_KEY !== undefined &&
    env.DOPPELCLAUDE_HTTP_API_KEY_FILE !== undefined
  )
    throw new Error(
      "set exactly one of DOPPELCLAUDE_HTTP_API_KEY or DOPPELCLAUDE_HTTP_API_KEY_FILE",
    );
  const key =
    env.DOPPELCLAUDE_HTTP_API_KEY ??
    (env.DOPPELCLAUDE_HTTP_API_KEY_FILE
      ? (await readFile(env.DOPPELCLAUDE_HTTP_API_KEY_FILE, "utf8")).trim()
      : undefined);
  if (key?.trim()) return key;
  if (key !== undefined) throw new Error("HTTP spike API key must not be blank");
  throw new Error("set DOPPELCLAUDE_HTTP_API_KEY or DOPPELCLAUDE_HTTP_API_KEY_FILE");
}

function integerOption(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum = 1,
  maximum = 2_147_483_647,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

/** Parse and validate daemon configuration once, before opening a socket. */
export async function httpConfigFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HttpEnvironmentConfig> {
  const stateDir = env.DOPPELCLAUDE_STATE_DIR ?? join(homedir(), ".local/state/doppelclaude");
  if (!stateDir.trim()) throw new Error("DOPPELCLAUDE_STATE_DIR must not be blank");
  const host = env.DOPPELCLAUDE_HTTP_HOST ?? "127.0.0.1";
  if (isIP(host) === 0)
    throw new Error("DOPPELCLAUDE_HTTP_HOST must be an IPv4 or IPv6 address literal");
  return {
    apiKey: await apiKeyFromEnvironment(env),
    host,
    port: integerOption(env, "PORT", 3456, 1, 65_535),
    stateDir,
    maxRuntimes: integerOption(env, "DOPPELCLAUDE_MAX_RUNTIMES", 32),
    idleTtlMs: integerOption(env, "DOPPELCLAUDE_IDLE_TTL_MS", 3_600_000),
    maxBodyBytes: integerOption(env, "DOPPELCLAUDE_MAX_BODY_BYTES", 2_097_152),
    requestTimeoutMs: integerOption(env, "DOPPELCLAUDE_REQUEST_TIMEOUT_MS", 600_000),
    shutdownTimeoutMs: integerOption(env, "DOPPELCLAUDE_SHUTDOWN_TIMEOUT_MS", 15_000),
    retryAttempts: integerOption(env, "DOPPELCLAUDE_RETRY_ATTEMPTS", 2, 0, 10),
  };
}
