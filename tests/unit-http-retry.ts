import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { createHttpServer } from "http-doppelclaude";

const KEY = "retry-key";
const MODEL = "claude-haiku-4-5";
const THREAD = "T-99999999-9999-4999-8999-999999999999";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(
  content: Message["content"] = [{ type: "text", text: "ok", citations: null }],
): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    content,
    model: MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    container: null,
    stop_details: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

async function* success(): AsyncIterable<CoreResponseEvent> {
  const answer = message();
  yield { type: "message_start", message: { ...answer, content: [] } };
  yield { type: "message_stop" };
  yield {
    type: "response",
    response: {
      commandId: "command",
      id: "response",
      requestedModel: MODEL,
      message: answer,
      lifecycle: "closed",
      error: null,
    },
  };
}

async function* failure(status?: 429 | 529, afterText = false): AsyncIterable<CoreResponseEvent> {
  if (afterText)
    yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } };
  yield {
    type: "terminal_error",
    reason: "error",
    message: status === undefined ? "upstream said HTTP 529" : `HTTP ${status}`,
    retryableStatus: status,
    response: {
      commandId: "command",
      id: "failed",
      requestedModel: MODEL,
      message: message([]),
      lifecycle: "failed",
      error: { reason: "error", message: "failed" },
    },
  };
}

function body(messages: unknown[] = [{ role: "user", content: "go" }]) {
  return {
    model: MODEL,
    max_tokens: 20,
    stream: true,
    system: `Amp Thread URL: https://ampcode.com/threads/${THREAD}`,
    messages,
  };
}

async function harness(options: {
  retryAttempts?: number;
  streams: Array<() => AsyncIterable<CoreResponseEvent>>;
  retryDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
}) {
  const calls: Array<{ kind: "turn" | "replay"; messages: RuntimeRequest["messages"] }> = [];
  const rebuilds: string[] = [];
  const next = (kind: "turn" | "replay", request: RuntimeRequest) => {
    calls.push({ kind, messages: structuredClone(request.messages) });
    const stream = options.streams.shift();
    assert.ok(stream, "unexpected runtime call");
    return stream();
  };
  const server = createHttpServer({
    apiKey: KEY,
    supportedModels: [],
    retryAttempts: options.retryAttempts,
    retryDelay: options.retryDelay ?? (async () => {}),
    createRuntime: () =>
      ({
        turn: (request: RuntimeRequest) => next("turn", request),
        replay: (request: RuntimeRequest) => next("replay", request),
        async markRebuild(reason: string) {
          rebuilds.push(reason);
        },
        async clear() {},
        async designateHost() {},
      }) as never,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    calls,
    rebuilds,
    post: (value: unknown, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify(value),
        signal,
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function count(output: string, event: string): number {
  return output.match(new RegExp(`event: ${event}`, "gu"))?.length ?? 0;
}

describe("HTTP transient retries", () => {
  it("retries a structured 429 and emits one successful envelope", async () => {
    const app = await harness({ streams: [() => failure(429), success] });
    try {
      const output = await (await app.post(body())).text();
      assert.equal(app.calls.length, 2);
      assert.deepEqual(
        app.calls.map((call) => call.kind),
        ["turn", "turn"],
      );
      assert.equal(count(output, "message_start"), 1);
      assert.equal(count(output, "message_stop"), 1);
      assert.equal(count(output, "error"), 0);
      assert.deepEqual(app.calls[0].messages, app.calls[1].messages);
    } finally {
      await app.close();
    }
  });

  it("makes three attempts when two 529 retries are exhausted", async () => {
    const app = await harness({
      retryAttempts: 2,
      streams: [() => failure(529), () => failure(529), () => failure(529)],
    });
    try {
      const output = await (await app.post(body())).text();
      assert.equal(app.calls.length, 3);
      assert.equal(count(output, "error"), 1);
      assert.equal(count(output, "message_stop"), 0);
    } finally {
      await app.close();
    }
  });

  it("does not infer retryability from error text", async () => {
    const app = await harness({ streams: [failure] });
    try {
      const output = await (await app.post(body())).text();
      assert.equal(app.calls.length, 1);
      assert.equal(count(output, "error"), 1);
      assert.equal(count(output, "message_stop"), 0);
    } finally {
      await app.close();
    }
  });

  it("does not retry a structured 529 after output was emitted", async () => {
    const app = await harness({ streams: [() => failure(529, true)] });
    try {
      const output = await (await app.post(body())).text();
      assert.equal(app.calls.length, 1);
      assert.match(output, /partial/u);
      assert.equal(count(output, "error"), 1);
      assert.equal(count(output, "message_stop"), 0);
    } finally {
      await app.close();
    }
  });

  it("does not respawn after the request is aborted during backoff", async () => {
    const entered = deferred();
    const controller = new AbortController();
    const app = await harness({
      streams: [() => failure(429)],
      retryDelay: async (_attempt, signal) => {
        entered.resolve();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    });
    try {
      const request = app.post(body(), controller.signal);
      await entered.promise;
      controller.abort();
      await assert.rejects(request);
      await new Promise(setImmediate);
      assert.equal(app.calls.length, 1);
    } finally {
      await app.close();
    }
  });

  it("replays cold tool results but turns normal user retries with unchanged messages", async () => {
    const history = [
      { role: "user", content: "use it" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "lookup", input: { q: "x" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "answer" }],
      },
    ];
    const cold = await harness({ streams: [() => failure(529), success] });
    try {
      const output = await (await cold.post(body(history))).text();
      assert.deepEqual(
        cold.calls.map((call) => call.kind),
        ["replay", "replay"],
      );
      assert.deepEqual(cold.calls[0].messages, cold.calls[1].messages);
      assert.equal(count(output, "message_stop"), 1);
    } finally {
      await cold.close();
    }
  });
});
