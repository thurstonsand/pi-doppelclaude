// Replays a DOPPELCLAUDE_RECORD_REQUESTS capture through a given HTTP server module with a fake
// runtime, reproducing production's request overlaps, and compares every sync decision with the
// production request_complete log. See README.md.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

interface Recorded {
  requestId: string;
  threadId: string;
  resolvedModel: string;
  requestedModel: string;
  line: string;
}
interface LogRecord {
  event: string;
  requestId?: string;
  threadId?: string | null;
  timestamp: string;
  durationMs?: number;
  httpStatus?: number | null;
  outcome?: string;
  reason?: string;
  [field: string]: unknown;
}
interface Request {
  id: string;
  threadId: string;
  body: string | null;
  start: number;
  end: number;
  production: LogRecord;
  messageCount: number;
  prefixes: string[];
  synthesized: boolean;
}
type Block = Record<string, unknown>;
type Message = { role: string; content: string | Block[] };

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    requests: { type: "string" },
    log: { type: "string" },
    out: { type: "string" },
    cap: { type: "string", default: "4096" },
  },
});
if (!values.server || !values.requests || !values.log || !values.out)
  throw new Error(
    "usage: replay.ts --server <server.ts> --requests <jsonl> --log <jsonl> --out <json>",
  );

async function* lines(path: string): AsyncIterable<string> {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim()) yield line;
}

// Only used to pick which later request echoes this one's reply; the server's own
// canonicalization decides every match, and the gate checks the result.
function strip(message: Message): string {
  const content =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content
          .filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking")
          .map(({ cache_control: _c, citations: _x, id: _i, tool_use_id: _t, ...block }) => block);
  return JSON.stringify({ role: message.role, content });
}
function prefixHashes(messages: Message[]): string[] {
  const hashes: string[] = [];
  let previous = "";
  for (const message of messages) {
    previous = createHash("sha1").update(previous).update(strip(message)).digest("hex");
    hashes.push(previous);
  }
  return hashes;
}

const production = new Map<string, LogRecord>();
const productionErrors: LogRecord[] = [];
for await (const line of lines(values.log)) {
  const record = JSON.parse(line) as LogRecord;
  if (record.event !== "request_complete") continue;
  if (record.requestId) production.set(record.requestId, record);
  if (record.threadId && record.httpStatus === 409) productionErrors.push(record);
}

const requests: Request[] = [];
const models = new Map<string, string>();
for await (const line of lines(values.requests)) {
  const recorded = JSON.parse(line) as Recorded & { request: { messages: Message[] } };
  const log = production.get(recorded.requestId);
  if (!log || !recorded.threadId) continue;
  models.set(recorded.requestedModel, recorded.resolvedModel);
  const end = Date.parse(log.timestamp);
  requests.push({
    id: recorded.requestId,
    threadId: recorded.threadId,
    body: JSON.stringify(recorded.request),
    start: end - (log.durationMs ?? 0),
    end,
    production: log,
    messageCount: recorded.request.messages.length,
    prefixes: prefixHashes(recorded.request.messages),
    synthesized: false,
  });
}
// A rejected request is never recorded. Amp's retry of a dropped stream resends the request still
// running on that thread, so a 409 is replayed as a copy of the request in flight at the time.
for (const rejected of productionErrors) {
  const at = Date.parse(rejected.timestamp);
  const running = requests.find(
    (request) => request.threadId === rejected.threadId && request.start <= at && at < request.end,
  );
  if (!running) continue;
  requests.push({
    ...running,
    id: `synthesized-409-${rejected.requestId}`,
    start: at - (rejected.durationMs ?? 0),
    end: at,
    production: rejected,
    synthesized: true,
  });
}
requests.sort((left, right) => left.start - right.start);

function replyFor(request: Request): { content: Block[]; stop: string } {
  const n = request.messageCount;
  for (const later of requests) {
    if (later.threadId !== request.threadId || later.start <= request.start) continue;
    if (later.messageCount <= n || later.prefixes[n - 1] !== request.prefixes[n - 1]) continue;
    const reply = (JSON.parse(later.body as string) as { messages: Message[] }).messages[n];
    if (reply?.role !== "assistant") continue;
    const content =
      typeof reply.content === "string" ? [{ type: "text", text: reply.content }] : reply.content;
    return {
      content,
      stop: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    };
  }
  return { content: [{ type: "text", text: `unseen reply ${request.id}` }], stop: "end_turn" };
}

let clock = requests[0]?.start ?? 0;
let expire: (() => void) | undefined;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
  if (delay === 30_000 && !expire) {
    expire = handler;
    return { unref() {}, ref() {}, [Symbol.toPrimitive]: () => 0 } as unknown as NodeJS.Timeout;
  }
  return realSetInterval(handler, delay, ...rest);
}) as typeof setInterval;

const { createHttpServer } = (await import(
  values.server
)) as typeof import("../../packages/http-doppelclaude/src/server.ts");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Flight {
  request: Request;
  admitted: ReturnType<typeof deferred>;
  release: ReturnType<typeof deferred>;
  abort: AbortController;
  response?: Promise<{ status: number; text: string }>;
  logs: LogRecord[];
}
let admitting: Flight | undefined;
let collecting: Flight | undefined;
const replayed: LogRecord[] = [];

function fakeTurn(flight: Flight, signal?: AbortSignal) {
  flight.admitted.resolve();
  const { content, stop } = replyFor(flight.request);
  const model = (JSON.parse(flight.request.body as string) as { model: string }).model;
  return (async function* () {
    await Promise.race([
      flight.release.promise,
      new Promise<never>((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      ),
    ]);
    if (!["success"].includes(flight.request.production.outcome ?? ""))
      throw new Error(`production outcome ${flight.request.production.outcome}`);
    const usage = {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const message: Record<string, unknown> = {
      id: "msg_replay",
      type: "message",
      role: "assistant",
      content,
      model,
      stop_reason: stop,
      stop_sequence: null,
      usage,
    };
    yield { type: "message_start", message: { ...message, content: [] as Block[] } };
    yield { type: "message_stop" };
    yield {
      type: "response",
      response: {
        commandId: "c",
        id: "r",
        requestedModel: model,
        message,
        observedUsage: usage,
        observedModel: null as string | null,
        lifecycle: "closed",
        error: null as string | null,
      },
    };
  })();
}

const server = createHttpServer({
  apiKey: "replay",
  supportedModels: [...models].map(([value, resolvedModel]) => ({
    value,
    resolvedModel,
    displayName: value,
    description: "",
  })),
  toolDescriptionCap: Number(values.cap),
  maxRuntimes: 32,
  idleTtlMs: 3_600_000,
  now: () => clock,
  log: (record) => {
    if (record.event !== "request_complete") return;
    (collecting ?? admitting)?.logs.push(record as LogRecord);
  },
  createRuntime() {
    const run = (request: { signal?: AbortSignal }) => {
      if (!admitting) throw new Error("turn outside an admission");
      return fakeTurn(admitting, request.signal);
    };
    return {
      turn: run,
      replay: run,
      async clear() {},
      async closePersistent() {},
      async markRebuild() {},
      async designateHost() {},
      test: {},
    } as never;
  },
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no address");
const url = `http://127.0.0.1:${address.port}/v1/messages`;

const events = requests.flatMap((request) => [
  { at: request.start, kind: "start" as const, request },
  { at: request.end, kind: "end" as const, request },
]);
events.sort((left, right) => left.at - right.at || (left.kind === "end" ? -1 : 1));
const flights = new Map<Request, Flight>();
const inFlight = new Map<string, number>();
const overlapAtStart = new Map<Request, boolean>();

for (const event of events) {
  clock = event.at;
  expire?.();
  await new Promise(setImmediate);
  if (event.kind === "start") {
    const flight: Flight = {
      request: event.request,
      admitted: deferred(),
      release: deferred(),
      abort: new AbortController(),
      logs: [],
    };
    flights.set(event.request, flight);
    overlapAtStart.set(event.request, (inFlight.get(event.request.threadId) ?? 0) > 0);
    admitting = flight;
    flight.response = fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "replay" },
      body: event.request.body,
      signal: flight.abort.signal,
    }).then(
      async (response) => ({ status: response.status, text: await response.text() }),
      () => ({ status: 0, text: "" }),
    );
    const early = flight.response.then(() => "done" as const);
    await Promise.race([flight.admitted.promise, early]);
    admitting = undefined;
    inFlight.set(event.request.threadId, (inFlight.get(event.request.threadId) ?? 0) + 1);
  } else {
    const flight = flights.get(event.request);
    if (!flight) continue;
    inFlight.set(event.request.threadId, (inFlight.get(event.request.threadId) ?? 1) - 1);
    collecting = flight;
    if (event.request.production.outcome === "disconnect") flight.abort.abort();
    else flight.release.resolve();
    await flight.response;
    for (let tries = 0; flight.logs.length === 0 && tries < 50; tries++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    collecting = undefined;
    const record = flight.logs[0];
    if (record) replayed.push({ ...record, replayOf: event.request.id });
    else replayed.push({ event: "missing", timestamp: "", replayOf: event.request.id });
  }
}
await new Promise<void>((resolve) => server.close(() => resolve()));

const COMPARED = [
  "httpStatus",
  "outcome",
  "messageCount",
  "historyFingerprint",
  "configurationFingerprint",
  "previousConfigurationFingerprint",
  "changedConfigurationFields",
  "sync",
  "reason",
  "forcedRebuild",
  "coldReplay",
] as const;
const byId = new Map(requests.map((request) => [request.id, request]));
const rows = replayed.map((record) => {
  const request = byId.get(record.replayOf as string) as Request;
  const differences = COMPARED.filter(
    (field) =>
      JSON.stringify(record[field] ?? null) !== JSON.stringify(request.production[field] ?? null),
  ).map((field) => ({
    field,
    production: request.production[field] ?? null,
    replay: record[field] ?? null,
  }));
  const signatureFields = record.configurationFields as Record<string, string> | undefined;
  return {
    requestId: request.id,
    threadId: request.threadId,
    synthesized: request.synthesized,
    overlappedAtStart: overlapAtStart.get(request),
    lane: record.lane ?? null,
    threadRuntimes: record.threadRuntimes ?? null,
    signature: signatureFields ? JSON.stringify({ ...signatureFields, model: undefined }) : null,
    production: {
      reason: request.production.reason ?? null,
      httpStatus: request.production.httpStatus ?? null,
    },
    replay: {
      reason: record.reason ?? null,
      httpStatus: record.httpStatus ?? null,
      outcome: record.outcome,
    },
    differences,
  };
});
const count = (values: Array<string | number | null | undefined>) =>
  Object.fromEntries(
    [...new Set(values)].map((value) => [String(value), values.filter((v) => v === value).length]),
  );
const summary = {
  server: values.server,
  requests: rows.length,
  synthesized409s: rows.filter((row) => row.synthesized).length,
  matchingProduction: rows.filter((row) => row.differences.length === 0).length,
  differingFields: count(
    rows.flatMap((row) => row.differences.map((difference) => difference.field)),
  ),
  productionReasons: count(
    rows.map((row) => row.production.reason ?? `status ${row.production.httpStatus}`),
  ),
  replayReasons: count(rows.map((row) => row.replay.reason ?? `status ${row.replay.httpStatus}`)),
  lanes: count(rows.map((row) => row.lane as string | null)),
  maxThreadRuntimes: Math.max(0, ...rows.map((row) => Number(row.threadRuntimes ?? 0))),
};
await writeFile(values.out, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
