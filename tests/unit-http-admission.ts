import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import { createHttpServer } from "http-doppelclaude";

const KEY = "admission-key";
const ids = [1, 2, 3, 4].map(
  (n) =>
    `T-${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`,
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function body(thread: string, messages: unknown[] = [{ role: "user", content: "go" }]) {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 100,
    stream: true,
    system: `Amp Thread URL: https://ampcode.com/threads/${thread}`,
    messages,
  };
}

function answer(): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok", citations: null }],
    model: "claude-haiku-4-5",
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

async function* stream(gate?: Promise<void>): AsyncIterable<CoreResponseEvent> {
  if (gate) await gate;
  const message = answer();
  yield { type: "message_start", message: { ...message, content: [] } };
  yield { type: "message_stop" };
  yield {
    type: "response",
    response: {
      commandId: "c",
      id: "r",
      requestedModel: message.model,
      message,
      lifecycle: "closed",
      error: null,
    },
  };
}

async function harness(options: {
  maxRuntimes: number;
  shutdownTimeoutMs?: number;
  turnGate?: Map<string, Promise<void>>;
  clearGate?: Map<string, Promise<void>>;
  failFirstRuntime?: boolean;
}) {
  const made: string[] = [];
  const cleared: string[] = [];
  const server = createHttpServer({
    apiKey: KEY,
    supportedModels: [],
    maxRuntimes: options.maxRuntimes,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 100,
    createRuntime(id) {
      made.push(id);
      if (options.failFirstRuntime && made.length === 1) throw new Error("factory failed");
      return {
        turn: () => stream(options.turnGate?.get(id)),
        replay: () => stream(options.turnGate?.get(id)),
        async clear() {
          cleared.push(id);
          await options.clearGate?.get(id);
        },
        async closePersistent() {},
        async markRebuild() {},
        async designateHost() {},
        test: {} as never,
      } as never;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const post = (value: unknown) =>
    fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify(value),
    });
  return {
    made,
    cleared,
    post,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("HTTP runtime admission", () => {
  it("releases direct reservations when runtime construction throws", async () => {
    const app = await harness({ maxRuntimes: 1, failFirstRuntime: true });
    try {
      const failed = await app.post(body(ids[0]));
      assert.equal(failed.status, 500);
      await failed.text();
      await new Promise(setImmediate);
      const same = await app.post(body(ids[0]));
      assert.equal(same.status, 200);
      await same.text();
      const other = await app.post(body(ids[1]));
      assert.equal(other.status, 200);
      await other.text();
      assert.deepEqual(app.made, [ids[0], ids[0], ids[1]]);
    } finally {
      await app.close();
    }
  });

  it("reserves a new key while its eviction is pending", async () => {
    const oldClear = deferred();
    const app = await harness({
      maxRuntimes: 1,
      clearGate: new Map([[ids[0], oldClear.promise]]),
    });
    try {
      await (await app.post(body(ids[0]))).text();
      const first = app.post(body(ids[1]));
      while (!app.cleared.includes(ids[0])) await new Promise(setImmediate);
      assert.equal((await app.post(body(ids[1]))).status, 409);
      oldClear.resolve();
      assert.equal((await first).status, 200);
      assert.deepEqual(app.made, [ids[0], ids[1]]);
    } finally {
      oldClear.resolve();
      await app.close();
    }
  });

  it("rejects unrelated admission when every live runtime is active", async () => {
    const active = deferred();
    const app = await harness({ maxRuntimes: 1, turnGate: new Map([[ids[0], active.promise]]) });
    try {
      const first = app.post(body(ids[0]));
      while (!app.made.includes(ids[0])) await new Promise(setImmediate);
      assert.equal((await app.post(body(ids[1]))).status, 503);
      assert.deepEqual(app.made, [ids[0]]);
      active.resolve();
      await first;
    } finally {
      active.resolve();
      await app.close();
    }
  });

  it("validates unknown tool results before allocating capacity", async () => {
    const app = await harness({ maxRuntimes: 1 });
    try {
      const invalid = body(ids[0], [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "orphan", content: "no" }],
        },
      ]);
      assert.equal((await app.post(invalid)).status, 400);
      assert.deepEqual(app.made, []);
      assert.equal((await app.post(body(ids[1]))).status, 200);
      assert.deepEqual(app.made, [ids[1]]);
    } finally {
      await app.close();
    }
  });

  it("keeps an unresolved clear charged to capacity and bounds the wait", async () => {
    const blocked = deferred();
    const app = await harness({
      maxRuntimes: 1,
      shutdownTimeoutMs: 10,
      clearGate: new Map([[ids[0], blocked.promise]]),
    });
    try {
      await (await app.post(body(ids[0]))).text();
      assert.equal((await app.post(body(ids[1]))).status, 503);
      assert.equal((await app.post(body(ids[2]))).status, 503);
      assert.deepEqual(app.made, [ids[0]]);
    } finally {
      blocked.resolve();
      await app.close();
    }
  });
});
