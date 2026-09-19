import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { type CoreResponseEvent, createCoreResponse, emptyUsage } from "doppelclaude/core-response";
import { PushQueue } from "doppelclaude/query-state";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { createHttpServer } from "http-doppelclaude";
import { until } from "./lib/turns.js";

const KEY = "expiry-key";
const MODEL = "claude-haiku-4-5";
const A = "T-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "T-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function body(thread: string, messages: unknown[] = [{ role: "user", content: "go" }]) {
  return {
    model: MODEL,
    max_tokens: 20,
    stream: true,
    system: `Amp Thread URL: https://ampcode.com/threads/${thread}`,
    tools: [{ name: "lookup", input_schema: { type: "object", properties: {} } }],
    messages,
  };
}

async function* native(
  content: Message["content"],
  stopReason: Message["stop_reason"] = "end_turn",
  gate?: Promise<void>,
): AsyncIterable<CoreResponseEvent> {
  if (gate) await gate;
  const handle = createCoreResponse("command", MODEL, new PushQueue<CoreResponseEvent>());
  handle.record.message.content = content;
  handle.record.message.stop_reason = stopReason;
  handle.record.message.usage = emptyUsage();
  handle.record.lifecycle = "closed";
  yield { type: "message_start", message: { ...handle.record.message, content: [] } };
  for (const [index, block] of content.entries()) {
    yield { type: "content_block_start", index, content_block: block };
    yield { type: "content_block_stop", index };
  }
  yield { type: "message_stop" };
  yield { type: "response", response: handle.record };
}

function terminal(reason: "aborted" | "error", message: string): CoreResponseEvent {
  const handle = createCoreResponse("command", MODEL, new PushQueue<CoreResponseEvent>());
  handle.record.lifecycle = "failed";
  handle.record.error = { reason, message };
  return { type: "terminal_error", reason, message, response: handle.record };
}

async function open(options: Parameters<typeof createHttpServer>[0]) {
  const server = createHttpServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    post: (value: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify(value),
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("HTTP runtime expiry", () => {
  it("expires an idle pending-tool runtime and cold-replays renamed tool history", async () => {
    let now = 100;
    let made = 0;
    const cleared: number[] = [];
    const calls: string[] = [];
    const app = await open({
      apiKey: KEY,
      supportedModels: [],
      idleTtlMs: 10,
      now: () => now,
      createRuntime: () => {
        const instance = ++made;
        return {
          turn: () => {
            calls.push(`${instance}:turn`);
            return native(
              [{ type: "tool_use", id: "sdk-old", name: "lookup", input: {}, caller: null }],
              "tool_use",
            );
          },
          replay: () => {
            calls.push(`${instance}:replay`);
            return native([{ type: "text", text: "recovered", citations: null }]);
          },
          async clear() {
            cleared.push(instance);
          },
          async markRebuild() {},
          async designateHost() {},
        } as never;
      },
    });
    try {
      await (await app.post(body(A))).text();
      now += 11;
      await until(() => cleared.includes(1), "the pending-tool runtime to expire and clear");
      const output = await (
        await app.post(
          body(A, [
            { role: "user", content: "go" },
            {
              role: "assistant",
              content: [{ type: "tool_use", id: "renamed", name: "lookup", input: {} }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "renamed", content: "value" }],
            },
          ]),
        )
      ).text();
      assert.match(output, /recovered/u);
      assert.equal(made, 2);
      assert.deepEqual(calls, ["1:turn", "2:replay"]);
    } finally {
      await app.close();
    }
  });

  it("skips a busy runtime during TTL expiry, then clears it after completion", async () => {
    let now = 0;
    const gate = deferred();
    let clearCount = 0;
    let started = false;
    const app = await open({
      apiKey: KEY,
      supportedModels: [],
      maxRuntimes: 1,
      idleTtlMs: 10,
      now: () => now,
      createRuntime: () =>
        ({
          turn: () => {
            started = true;
            return native(
              [{ type: "text", text: "done", citations: null }],
              "end_turn",
              gate.promise,
            );
          },
          replay: () => native([]),
          async clear() {
            clearCount++;
          },
          async markRebuild() {},
          async designateHost() {},
        }) as never,
    });
    try {
      const first = app.post(body(A));
      await until(() => started, "the first runtime to become busy");
      now = 20;
      await new Promise((resolve) => setTimeout(resolve, 15));
      assert.equal(clearCount, 0);
      assert.equal((await app.post(body(B))).status, 503);
      gate.resolve();
      await (await first).text();
      now = 40;
      await until(() => clearCount === 1, "the completed runtime to expire and clear");
    } finally {
      gate.resolve();
      await app.close();
    }
  });

  it("aborts timed-out requests, emits one SSE error, and rebuilds the next request", async () => {
    let calls = 0;
    let capturedSignal: AbortSignal | undefined;
    const rebuilds: string[] = [];
    const app = await open({
      apiKey: KEY,
      supportedModels: [],
      requestTimeoutMs: 10,
      retryAttempts: 0,
      createRuntime: () =>
        ({
          turn(request: RuntimeRequest) {
            calls++;
            if (calls > 1)
              return native([{ type: "text", text: "after-timeout", citations: null }]);
            capturedSignal = request.signal;
            return (async function* () {
              if (!request.signal.aborted)
                await once(request.signal, "abort", { signal: AbortSignal.timeout(1_000) });
              yield terminal("aborted", "request timeout");
            })();
          },
          replay: () => native([]),
          async clear() {},
          async markRebuild(reason: string) {
            rebuilds.push(reason);
          },
          async designateHost() {},
        }) as never,
    });
    try {
      const timedOut = await (await app.post(body(A))).text();
      assert.equal(capturedSignal?.aborted, true);
      assert.equal(timedOut.match(/event: error/gu)?.length, 1);
      assert.doesNotMatch(timedOut, /event: message_stop/u);
      const recovered = await (await app.post(body(A))).text();
      assert.deepEqual(rebuilds, ["HTTP previous request failed"]);
      assert.match(recovered, /after-timeout/u);
    } finally {
      await app.close();
    }
  });
});
