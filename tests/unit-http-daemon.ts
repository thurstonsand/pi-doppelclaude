import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import { createHttpServer, httpConfigFromEnvironment } from "http-doppelclaude";

const key = "test-key";
const model = "claude-haiku-4-5";
const thread = "T-11111111-1111-4111-8111-111111111111";

function requestBody(messages: unknown = [{ role: "user", content: "go" }]) {
  return {
    model,
    max_tokens: 20,
    stream: true,
    system: `Amp Thread URL: https://ampcode.com/threads/${thread}`,
    messages,
  };
}

async function* successful(): AsyncIterable<CoreResponseEvent> {
  const message = {
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    model,
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
  } as Message;
  yield { type: "message_start", message: { ...message, content: [] } };
  yield { type: "message_stop" };
  yield {
    type: "response",
    response: {
      commandId: "c",
      id: "r",
      requestedModel: model,
      message,
      lifecycle: "closed",
      error: null,
    },
  };
}

async function openServer(options: Parameters<typeof createHttpServer>[0]) {
  const server = createHttpServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    post: (body: unknown) =>
      fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
      }),
  };
}

describe("HTTP daemon lifecycle", () => {
  it("does not allocate a runtime for a malformed history", async () => {
    let allocations = 0;
    const app = await openServer({
      apiKey: key,
      supportedModels: [],
      createRuntime() {
        allocations++;
        throw new Error("must not allocate");
      },
    });
    assert.equal((await app.post(requestBody([]))).status, 400);
    assert.equal(allocations, 0);
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  });

  it("returns from shutdown deadline when runtime clear never settles", async () => {
    const app = await openServer({
      apiKey: key,
      supportedModels: [],
      shutdownTimeoutMs: 20,
      createRuntime() {
        return {
          turn: successful,
          replay: successful,
          clear: () => new Promise<void>(() => {}),
          designateHost: async () => {},
          markRebuild: async () => {},
        } as never;
      },
    });
    assert.equal((await app.post(requestBody())).status, 200);
    const started = Date.now();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    assert.ok(Date.now() - started < 250, "shutdown callback missed its deadline");
  });

  it("joins repeated close calls without closing the native server twice", async () => {
    const app = await openServer({ apiKey: key, supportedModels: [] });
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      app.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("does not keep a process alive for the default shutdown interval after a clean close", async () => {
    const source = `
      import { createHttpServer } from "./packages/http-doppelclaude/src/server.ts";
      const server = createHttpServer({ apiKey: "x", supportedModels: [], createRuntime: () => ({ clear: async () => {} }) });
      server.listen(0, "127.0.0.1", () => server.close(() => {}));
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source],
      {
        cwd: process.cwd(),
        stdio: "pipe",
      },
    );
    const exited = once(child, "exit");
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("child remained alive after clean shutdown")), 3_000),
    );
    const [code] = await Promise.race([exited, timeout]);
    assert.equal(code, 0);
  });
});

describe("HTTP daemon configuration", () => {
  const base = { DOPPELCLAUDE_HTTP_API_KEY: key };

  it("accepts zero retries", async () => {
    const parsed = await httpConfigFromEnvironment({
      ...base,
      DOPPELCLAUDE_RETRY_ATTEMPTS: "0",
    });
    assert.equal(parsed.retryAttempts, 0);
    assert.equal(parsed.host, "127.0.0.1");
  });

  it("accepts IPv4 and IPv6 bind address literals", async () => {
    for (const host of ["0.0.0.0", "::", "2001:db8::1"])
      assert.equal(
        (await httpConfigFromEnvironment({ ...base, DOPPELCLAUDE_HTTP_HOST: host })).host,
        host,
      );
  });

  it("rejects invalid bind addresses and out-of-range resource settings", async () => {
    for (const env of [
      { ...base, DOPPELCLAUDE_HTTP_HOST: "" },
      { ...base, DOPPELCLAUDE_HTTP_HOST: "localhost" },
      { ...base, DOPPELCLAUDE_HTTP_HOST: "127.0.0.1:3456" },
      { ...base, PORT: "65536" },
      { ...base, DOPPELCLAUDE_IDLE_TTL_MS: "2147483648" },
      { ...base, DOPPELCLAUDE_RETRY_ATTEMPTS: "11" },
      { ...base, DOPPELCLAUDE_STATE_DIR: "  " },
    ])
      await assert.rejects(httpConfigFromEnvironment(env));
  });
});
