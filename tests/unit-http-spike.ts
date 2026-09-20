import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, it } from "node:test";
import type { ModelInfo, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Message, MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { createHttpServer, projectHttpModels } from "http-doppelclaude";

const KEY = "test-key";
const A = "T-11111111-1111-4111-8111-111111111111";
const B = "T-22222222-2222-4222-8222-222222222222";
const SERVED_MODEL = "claude-served-9-20990101";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(content: Message["content"], stop: Message["stop_reason"] = "end_turn"): Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "claude-haiku-4-5",
    stop_reason: stop,
    stop_sequence: null,
    container: null,
    stop_details: null,
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
      cache_creation: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}
async function* native(
  content: Message["content"],
  stop: Message["stop_reason"] = "end_turn",
  modelId = SERVED_MODEL,
): AsyncIterable<CoreResponseEvent> {
  const value = { ...message(content, stop), model: modelId };
  yield { type: "message_start", message: { ...value, content: [] } };
  for (const [index, block] of content.entries()) {
    yield { type: "content_block_start", index, content_block: block };
    if (block.type === "thinking")
      yield {
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: block.signature },
      };
    yield { type: "content_block_stop", index };
  }
  yield {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null, container: null, stop_details: null },
    usage: value.usage,
  };
  yield { type: "message_stop" };
  yield {
    type: "response",
    response: {
      commandId: "c",
      id: "r",
      requestedModel: value.model,
      message: value,
      observedUsage: value.usage,
      observedModel: value.model,
      lifecycle: "closed",
      error: null,
    },
  };
}

function fakeRuntime(requests: RuntimeRequest[], rebuilds: string[] = []) {
  return {
    turn(request: RuntimeRequest) {
      requests.push(request);
      return native(
        [
          { type: "tool_use", id: "sdk-1", name: "lookup", input: { n: 1 } },
          { type: "tool_use", id: "sdk-2", name: "lookup", input: { n: 2 } },
        ] as Message["content"],
        "tool_use",
      );
    },
    replay(request: RuntimeRequest) {
      requests.push(request);
      return native(
        [
          { type: "thinking", thinking: "why", signature: "signed" },
          { type: "text", text: "done" },
        ] as Message["content"],
        "end_turn",
      );
    },
    async clear() {},
    async closePersistent() {},
    async markRebuild(reason: string) {
      rebuilds.push(reason);
    },
    async designateHost() {},
    test: {} as never,
  };
}

function body(thread: string, messages: unknown[] = [{ role: "user", content: "go" }]) {
  return {
    model: "claude-haiku-4-5",
    max_tokens: 100,
    stream: true,
    system: `x\nAmp Thread URL: https://ampcode.com/threads/${thread}`,
    tools: [
      {
        name: "lookup",
        description: "lookup",
        input_schema: { type: "object", properties: { n: { type: "number" } } },
      },
    ],
    messages,
  };
}
async function harness(supportedModels: readonly ModelInfo[] = []) {
  const requests = new Map<string, RuntimeRequest[]>();
  const rebuilds = new Map<string, string[]>();
  const logs: Array<Record<string, unknown>> = [];
  const server = createHttpServer({
    apiKey: KEY,
    supportedModels,
    log: (record) => logs.push(record),
    createRuntime(id) {
      const seen: RuntimeRequest[] = [];
      const marked: string[] = [];
      requests.set(id, seen);
      rebuilds.set(id, marked);
      return fakeRuntime(seen, marked) as never;
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    requests,
    rebuilds,
    logs,
    post: (value: unknown, key = KEY) =>
      fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify(value),
      }),
    rawPost: (value: string) =>
      fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: value,
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("native HTTP frontend", () => {
  it("projects resolved catalog models, filters aliases, and deduplicates stable IDs", () => {
    assert.deepEqual(
      projectHttpModels([
        {
          value: "opus[1m]",
          resolvedModel: "claude-opus-5[1m]",
          displayName: "Opus 5",
          description: "",
        },
        {
          value: "claude-opus-5-20260901",
          resolvedModel: "claude-opus-5",
          displayName: "Duplicate Opus",
          description: "",
        },
        {
          value: "claude-haiku-4-5",
          displayName: "Haiku 4.5",
          description: "",
        },
        { value: "sonnet", displayName: "Alias", description: "" },
      ]),
      [
        { id: "claude-opus-5", type: "model", display_name: "Opus 5", created_at: null },
        {
          id: "claude-haiku-4-5",
          type: "model",
          display_name: "Haiku 4.5",
          created_at: null,
        },
      ],
    );
  });

  it("authenticates before parsing and strictly identifies Amp threads", async () => {
    const app = await harness();
    try {
      assert.equal((await app.post("bad", "wrong")).status, 401);
      assert.equal((await app.post({ ...body(A), system: "none" })).status, 400);
      assert.equal(
        (
          await app.post({
            ...body(A),
            system: `Amp Thread URL: https://ampcode.com/threads/${A} trailing`,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await app.post({
            ...body(A),
            system: `Amp Thread URL: https://ampcode.com/threads/${A}\nAmp Thread URL: https://ampcode.com/threads/${B}`,
          })
        ).status,
        400,
      );
      assert.deepEqual(
        app.logs.map((record) => record.markerCount),
        [0, 0, 2],
      );
      assert.ok(app.logs.every((record) => record.outcome === "error"));
    } finally {
      await app.close();
    }
  });

  it("reports schema paths and unsupported fields without echoing request values", async () => {
    const app = await harness();
    try {
      const privateValue = "private-value-that-must-not-be-echoed";
      const rootResponse = await app.post({ ...body(A), unsupported_root: privateValue });
      assert.equal(rootResponse.status, 400);
      const rootError = await rootResponse.text();
      assert.match(
        rootError,
        /schema validation failed at \/: must not have additional properties/,
      );
      assert.match(rootError, /additionalProperties.*unsupported_root/);
      assert.doesNotMatch(rootError, new RegExp(privateValue));

      const thinkingResponse = await app.post({
        ...body(A),
        thinking: { type: "adaptive", budget_tokens: privateValue },
      });
      assert.equal(thinkingResponse.status, 400);
      const thinkingError = await thinkingResponse.text();
      assert.match(thinkingError, /schema validation failed at \/thinking:/);
      assert.match(thinkingError, /additionalProperties.*budget_tokens/);
      assert.doesNotMatch(thinkingError, new RegExp(privateValue));
    } finally {
      await app.close();
    }
  });

  it("forwards enabled thinking budgets exactly and rejects invalid budgets", async () => {
    const app = await harness();
    try {
      const response = await app.post({
        ...body(A),
        max_tokens: 2049,
        thinking: { type: "enabled", budget_tokens: 8193, display: "summarized" },
      });
      assert.equal(response.status, 200);
      await response.text();
      const request = app.requests.get(A)?.[0];
      assert.ok(request);
      assert.deepEqual(request.options?.thinking, { type: "enabled", budgetTokens: 8193 });
      assert.deepEqual(request.options?.extraArgs, { "thinking-display": "summarized" });

      for (const thinking of [
        { type: "enabled" },
        { type: "enabled", budget_tokens: 2048.5 },
        { type: "enabled", budget_tokens: 1023 },
      ]) {
        const invalid = await app.post({ ...body(B), thinking });
        assert.equal(invalid.status, 400);
        assert.match(await invalid.text(), /schema validation failed at \/thinking/);
      }
    } finally {
      await app.close();
    }
  });

  it("sends native requests, parameters, schemas, maps, and raw SSE", async () => {
    const app = await harness();
    try {
      const schema = {
        type: "object",
        properties: { n: { type: "number", minimum: 1 } },
        required: ["n"],
        additionalProperties: false,
        custom: { untouched: true },
      };
      const response = await app.post({
        ...body(A),
        max_tokens: 128_000,
        tools: [{ name: "lookup", description: "lookup", input_schema: schema }],
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /"stop_reason":"tool_use"/);
      assert.match(text, /"input_tokens":11/);
      const request = app.requests.get(A)?.[0];
      assert.ok(request);
      assert.deepEqual(request.messages, [{ role: "user", content: "go" }]);
      assert.deepEqual(request.tools?.[0]?.input_schema, schema);
      assert.equal(request.toolNameToSdk?.get("lookup"), "mcp__custom-tools__lookup");
      assert.equal(request.effort, "high");
      assert.equal(request.maxTokens, 128_000);
      assert.deepEqual(request.options?.tools, []);
      assert.deepEqual(request.options?.settingSources, []);
      assert.deepEqual(request.options?.thinking, { type: "adaptive" });
      assert.deepEqual(request.options?.extraArgs, { "thinking-display": "summarized" });
      assert.equal(request.options?.env?.ENABLE_TOOL_SEARCH, "false");
      assert.equal(request.options?.env?.DISABLE_AUTO_COMPACT, "1");
      assert.equal(request.options?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
      assert.equal(request.options?.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000");
    } finally {
      await app.close();
    }
  });

  it("resolves renamed parallel results by assistant call position and result id", async () => {
    const app = await harness();
    try {
      await (await app.post(body(A))).text();
      const history = [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "renamed-a", name: "lookup", input: { n: 1 } },
            { type: "tool_use", id: "renamed-b", name: "lookup", input: { n: 2 } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "renamed-b", content: "two" },
            { type: "tool_result", tool_use_id: "renamed-a", content: "one" },
          ],
        },
      ];
      await (await app.post(body(A, history))).text();
      const messages = app.requests.get(A)?.[1]?.messages as MessageParam[];
      const results = messages[2].content as Array<{
        type: string;
        tool_use_id: string;
        content: string;
      }>;
      assert.deepEqual(
        results.map(({ tool_use_id, content }) => ({ tool_use_id, content })),
        [
          { tool_use_id: "sdk-2", content: "two" },
          { tool_use_id: "sdk-1", content: "one" },
        ],
      );
    } finally {
      await app.close();
    }
  });

  it("strips cache controls and explicitly replays cold tool-result history", async () => {
    const app = await harness();
    try {
      const history = [
        { role: "user", content: "go", cache_control: { type: "ephemeral" } },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "client",
              name: "lookup",
              input: { n: 1, nested: { cache_control: "keep-input" } },
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "client",
              content: [
                {
                  type: "text",
                  text: "ok",
                  cache_control: { type: "ephemeral" },
                },
              ],
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ];
      const text = await (await app.post(body(A, history))).text();
      assert.match(text, /signature_delta/);
      const sent = JSON.stringify(app.requests.get(A)?.[0]?.messages);
      assert.match(sent, /keep-input/);
      assert.equal((sent.match(/cache_control/g) ?? []).length, 1);
    } finally {
      await app.close();
    }
  });

  it("rejects empty and role-invalid message histories", async () => {
    const app = await harness();
    try {
      for (const messages of [
        [],
        [{ role: "user", content: "" }],
        [{ role: "user", content: [] }],
        [{ role: "assistant", content: [{ type: "tool_result", tool_use_id: "x", content: "x" }] }],
        [{ role: "user", content: [{ type: "tool_use", id: "x", name: "lookup", input: {} }] }],
      ])
        assert.equal((await app.post(body(A, messages))).status, 400);
    } finally {
      await app.close();
    }
  });

  it("rejects non-object tool schemas before allocating a runtime", async () => {
    const app = await harness();
    try {
      for (const input_schema of [{ properties: {} }, { type: "array", items: {} }]) {
        const response = await app.post({
          ...body(A),
          tools: [{ name: "lookup", input_schema }],
        });
        assert.equal(response.status, 400);
      }
      assert.equal(app.requests.size, 0);
    } finally {
      await app.close();
    }
  });

  it("validates JSON, markers, model, results, and tool_choice none over HTTP", async () => {
    const app = await harness();
    try {
      assert.equal((await app.rawPost("{")).status, 400);
      assert.equal((await app.post({ ...body(A), model: "wrong" })).status, 400);
      assert.equal((await app.post({ ...body(A), model: "/claude-haiku-4-5" })).status, 400);
      assert.equal((await app.post({ ...body(A), model: "claude-haiku-latest" })).status, 400);
      assert.equal((await app.post({ ...body(A), temperature: 0 })).status, 400);
      assert.equal(
        (
          await app.post({
            ...body(A),
            system: [
              { type: "text", text: `Amp Thread URL: https://ampcode.com/threads/${A}` },
              { type: "text", text: `Amp Thread URL: https://ampcode.com/threads/${B}` },
            ],
          })
        ).status,
        400,
      );
      for (const content of [
        [{ type: "tool_result", tool_use_id: "missing", content: "x" }],
        [
          { type: "tool_result", tool_use_id: "x", content: "one" },
          { type: "tool_result", tool_use_id: "x", content: "two" },
        ],
      ]) {
        const messages = [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "x", name: "lookup", input: {} }],
          },
          { role: "user", content },
        ];
        assert.equal((await app.post(body(A, messages))).status, 400);
      }
      assert.equal(
        (
          await app.post(
            body(A, [
              { role: "user", content: "go" },
              {
                role: "assistant",
                content: [
                  { type: "tool_use", id: "x", name: "lookup", input: {} },
                  { type: "tool_use", id: "y", name: "lookup", input: {} },
                ],
              },
              {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "x", content: "one" }],
              },
            ]),
          )
        ).status,
        400,
      );
      const none = await app.post({ ...body(B), tool_choice: { type: "none" } });
      await none.text();
      assert.deepEqual(app.requests.get(B)?.[0]?.tools, []);
      assert.equal(app.requests.get(B)?.[0]?.model, "claude-haiku-4-5");
    } finally {
      await app.close();
    }
  });

  it("normalizes requester models independently", async () => {
    const app = await harness();
    try {
      const first = await app.post({ ...body(A), model: "claude-opus-4-6" });
      assert.equal(first.status, 200);
      await first.text();
      const other = await app.post({ ...body(B), model: "vendor/claude-haiku-4-5" });
      assert.equal(other.status, 200);
      await other.text();
      const switched = await app.post({ ...body(A), model: "claude-sonnet-5" });
      assert.equal(switched.status, 200);
      await switched.text();
      assert.deepEqual(
        app.requests.get(A)?.map((request) => request.model),
        ["claude-opus-4-6", "claude-sonnet-5"],
      );
      assert.deepEqual(
        app.requests.get(B)?.map((request) => request.model),
        ["claude-haiku-4-5"],
      );
      assert.ok(app.rebuilds.get(A)?.includes("HTTP history diverged"));
    } finally {
      await app.close();
    }
  });

  it("snapshots aliases with exact-row precedence, unique families, and duplicate deduplication", async () => {
    const supportedModels: ModelInfo[] = [
      {
        value: "opus",
        resolvedModel: "claude-opus-4-20250514",
        displayName: "Opus",
        description: "",
      },
      {
        value: "claude-opus-5-20260901",
        displayName: "Newer Opus",
        description: "",
      },
      {
        value: "claude-opus-6-20270901",
        displayName: "Newest Opus",
        description: "",
      },
      {
        value: "claude-fable-5-20260901",
        displayName: "Fable",
        description: "",
      },
      {
        value: "fable-preview",
        resolvedModel: "claude-fable-5-20260901",
        displayName: "Duplicate Fable",
        description: "",
      },
    ];
    const app = await harness(supportedModels);
    supportedModels[0].resolvedModel = "claude-opus-9-20991231";
    supportedModels[3].value = "claude-fable-9-20991231";
    try {
      const opus = await app.post({ ...body(A), model: "opus" });
      const opusSse = await opus.text();
      assert.equal(opus.status, 200);
      assert.match(opusSse, new RegExp(`"model":"${SERVED_MODEL}"`));

      const fable = await app.post({ ...body(B), model: "anthropic/fable" });
      const fableSse = await fable.text();
      assert.equal(fable.status, 200);
      assert.match(fableSse, new RegExp(`"model":"${SERVED_MODEL}"`));

      const explicit = await app.post({ ...body(A), model: "vendor/claude-haiku-9-20991231" });
      const explicitSse = await explicit.text();
      assert.equal(explicit.status, 200);
      assert.match(explicitSse, new RegExp(`"model":"${SERVED_MODEL}"`));
      assert.deepEqual(
        app.requests.get(A)?.map((request) => request.model),
        ["claude-opus-4-20250514", "claude-haiku-9-20991231"],
      );
      assert.deepEqual(
        app.requests.get(B)?.map((request) => request.model),
        ["claude-fable-5-20260901"],
      );
    } finally {
      await app.close();
    }
  });

  it("rejects absent and ambiguous aliases without choosing the first candidate", async () => {
    const app = await harness([
      {
        value: "fable",
        resolvedModel: "fable",
        displayName: "Invalid Fable",
        description: "",
      },
      {
        value: "claude-fable-4-20250514",
        displayName: "Fable 4",
        description: "",
      },
      {
        value: "fable-preview",
        resolvedModel: "claude-fable-5-20260901",
        displayName: "Fable 5",
        description: "",
      },
    ]);
    try {
      for (const model of ["opus", "provider/fable"]) {
        const response = await app.post({ ...body(A), model });
        assert.equal(response.status, 400);
        assert.match(
          await response.text(),
          new RegExp(`model alias ${model.split("/").at(-1)} is unavailable`),
        );
      }
      const explicit = await app.post({
        ...body(A),
        model: "provider/claude-opus-4-20250514",
      });
      assert.equal(explicit.status, 200);
      assert.match(await explicit.text(), new RegExp(`"model":"${SERVED_MODEL}"`));
      assert.equal(app.requests.get(A)?.[0]?.model, "claude-opus-4-20250514");
    } finally {
      await app.close();
    }
  });

  it("enforces body and runtime capacity limits", async () => {
    const server = createHttpServer({
      apiKey: KEY,
      supportedModels: [],
      maxBodyBytes: 2_000,
      maxRuntimes: 1,
      createRuntime: () => fakeRuntime([]) as never,
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
    try {
      assert.equal((await post({ padding: "x".repeat(3_000) })).status, 413);
      // Invalid requests do not consume runtime capacity.
      assert.equal((await post({ ...body(A), stream: false })).status, 400);
      const first = await post(body(A));
      await first.text();
      // Capacity pressure evicts the least-recently-used idle runtime.
      assert.equal((await post(body(B))).status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("isolates simultaneous threads, retains a same-thread lock, and rebuilds after abort", async () => {
    const entered = deferred();
    const release = deferred();
    const interrupted = deferred();
    const rebuilds = new Map<string, string[]>();
    const identities = new Map<string, object>();
    const server = createHttpServer({
      apiKey: KEY,
      supportedModels: [],
      createRuntime(id) {
        const identity = {};
        identities.set(id, identity);
        const marked: string[] = [];
        rebuilds.set(id, marked);
        let turns = 0;
        return {
          ...fakeRuntime([], marked),
          turn(request: RuntimeRequest) {
            turns++;
            if (id === A && turns === 1) {
              request.signal?.addEventListener("abort", interrupted.resolve, { once: true });
              return (async function* () {
                yield {
                  type: "message_start",
                  message: { ...message([]), content: [] },
                } as CoreResponseEvent;
                entered.resolve();
                await release.promise;
                yield* native([{ type: "text", text: "A literal", citations: null }]);
              })();
            }
            return native([
              { type: "text", text: id === A ? "A next" : "B literal", citations: null },
            ]);
          },
        } as never;
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/v1/messages`;
    const post = (value: unknown, signal?: AbortSignal) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify(value),
        signal,
      });
    try {
      const firstA = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
        const outgoing = httpRequest(
          url,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-api-key": KEY },
          },
          resolve,
        );
        outgoing.on("error", reject);
        outgoing.end(JSON.stringify(body(A)));
      });
      await entered.promise;
      const firstResponse = await firstA;
      assert.equal((await post(body(A))).status, 409);
      const bText = await (await post(body(B))).text();
      assert.match(bText, /B literal/);
      assert.notEqual(identities.get(A), identities.get(B));
      assert.equal((await post(body(A))).status, 409);
      const closed = once(firstResponse.socket, "close");
      firstResponse.socket.destroy();
      await closed;
      await interrupted.promise;
      release.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const next = await post(body(A));
      assert.match(await next.text(), /A next/);
      assert.ok(
        rebuilds.get(A)?.some((reason) => reason.includes("previous request failed")),
        JSON.stringify(rebuilds.get(A)),
      );
    } finally {
      release.resolve();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not emit a successful terminal stop after a native stream error", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const server = createHttpServer({
      apiKey: KEY,
      supportedModels: [],
      log: (record) => logs.push(record),
      createRuntime: () =>
        ({
          ...fakeRuntime([]),
          turn: () =>
            (async function* (): AsyncIterable<CoreResponseEvent> {
              yield {
                type: "message_start",
                message: { ...message([]), content: [] },
              };
              yield { type: "message_stop" };
              yield {
                type: "terminal_error",
                reason: "error",
                message: "native boom",
                response: {
                  commandId: "c",
                  id: "r",
                  requestedModel: "claude-haiku-4-5",
                  message: message([]),
                  lifecycle: "failed",
                  error: { reason: "error", message: "native boom" },
                },
              };
            })(),
        }) as never,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify(body(A)),
      });
      const text = await response.text();
      assert.match(text, /event: error/);
      assert.match(text, /native boom/);
      assert.doesNotMatch(text, /event: message_stop/);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].outcome, "error");
      assert.equal(logs[0].stage, "execution");
      assert.equal(logs[0].httpStatus, 200);
      assert.equal(logs[0].errorCategory, "sdk_stream");
      assert.doesNotMatch(JSON.stringify(logs), /native boom|test-key/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("forces rebuilds for edited history and changed request signatures", async () => {
    const app = await harness();
    try {
      await (await app.post(body(A))).text();
      await (
        await app.post(
          body(A, [
            { role: "user", content: "edited" },
            { role: "assistant", content: [{ type: "text", text: "old" }] },
            { role: "user", content: "next" },
          ]),
        )
      ).text();
      assert.match(app.rebuilds.get(A)?.[0] ?? "", /history diverged/);
      await (
        await app.post({
          ...body(A, [
            { role: "user", content: "edited" },
            { role: "assistant", content: [{ type: "text", text: "old" }] },
            { role: "user", content: "next" },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
            { role: "user", content: "again" },
          ]),
          max_tokens: 101,
        })
      ).text();
      assert.ok(app.rebuilds.get(A)?.some((reason) => reason.includes("settings changed")));
    } finally {
      await app.close();
    }
  });

  it("identifies changed configuration fields without logging their values", async () => {
    const cases: Array<{ field: string; update: Record<string, unknown> }> = [
      { field: "model", update: { model: "claude-opus-5" } },
      { field: "prompt", update: { system: `${body(A).system}\nprivate-prompt-change` } },
      {
        field: "tools",
        update: { tools: [{ ...body(A).tools[0], description: "private-tool-change" }] },
      },
      { field: "toolChoice", update: { tool_choice: { type: "auto" } } },
      { field: "effort", update: { output_config: { effort: "high" } } },
      { field: "thinking", update: { thinking: { type: "enabled", budget_tokens: 4000 } } },
      { field: "maxTokens", update: { max_tokens: 101 } },
    ];
    for (const { field, update } of cases) {
      const app = await harness();
      try {
        for (const request of [body(A), { ...body(A), ...update }, { ...body(A), ...update }]) {
          const response = await app.post(request);
          assert.equal(response.status, 200);
          await response.text();
        }
        assert.equal(app.logs[0].changedConfigurationFields, null);
        assert.deepEqual(app.logs[1].changedConfigurationFields, [field]);
        assert.deepEqual(app.logs[2].changedConfigurationFields, []);
        const hashes = app.logs[1].configurationFields as Record<string, string>;
        assert.equal(Object.keys(hashes).length, 7);
        assert.ok(Object.values(hashes).every((hash) => /^[a-f0-9]{16}$/u.test(hash)));
        assert.doesNotMatch(JSON.stringify(app.logs), /private-prompt-change|private-tool-change/);
      } finally {
        await app.close();
      }
    }
  });

  it("logs warm reuse and main/Oracle/main displacement without conflating cache reads", async () => {
    const logs: Array<Record<string, unknown>> = [];
    let spawns = 0;
    const server = createHttpServer({
      apiKey: KEY,
      supportedModels: [
        { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus", description: "" },
      ],
      log: (record) => logs.push(record),
      queryFactory: ({ prompt, options }) => {
        spawns++;
        return {
          async *[Symbol.asyncIterator]() {
            for await (const _ of prompt) {
              yield* [
                { type: "system", subtype: "init", session_id: options?.resume ?? "cc-test" },
                {
                  type: "stream_event",
                  event: {
                    type: "message_start",
                    message: {
                      model: options?.model,
                      usage: {
                        input_tokens: 2,
                        cache_read_input_tokens: 17000,
                        cache_creation_input_tokens: 0,
                      },
                    },
                  },
                },
                {
                  type: "stream_event",
                  event: {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                },
                {
                  type: "stream_event",
                  event: {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "ok" },
                  },
                },
                { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
                {
                  type: "stream_event",
                  event: {
                    type: "message_delta",
                    delta: { stop_reason: "end_turn" },
                    usage: { output_tokens: 9 },
                  },
                },
                { type: "stream_event", event: { type: "message_stop" } },
                {
                  type: "result",
                  subtype: "success",
                  result: "ok",
                  is_error: false,
                  modelUsage: {},
                },
              ] as unknown as SDKMessage[];
            }
          },
          initializationResult: async () => ({}),
          setMcpServers: async () => ({
            added: [] as string[],
            removed: [] as string[],
            errors: {},
          }),
          setModel: async () => {},
          interrupt: async () => ({}),
          close: () => {},
        } as unknown as Query;
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const main = { ...body(A), model: "doppelclaude/opus" };
    const history = [
      ...main.messages,
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: "private-main-followup" },
    ];
    try {
      for (const request of [
        main,
        { ...main, messages: history },
        {
          ...main,
          model: "claude-fable-5-1",
          system: `${main.system}\nprivate-oracle-instructions`,
          messages: [{ role: "user", content: "private-oracle-question" }],
        },
        {
          ...main,
          messages: [
            ...history,
            { role: "assistant", content: [{ type: "text", text: "ok" }] },
            { role: "user", content: "private-return" },
          ],
        },
      ]) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": KEY },
          body: JSON.stringify(request),
        });
        assert.equal(response.status, 200);
        assert.match(await response.text(), /ok/);
      }
      const completed = logs.filter((record) => record.event === "request_complete");
      assert.equal(completed.length, 4);
      assert.equal(spawns, 3);
      assert.deepEqual(
        completed.map((record) => record.reason),
        ["first_request", "compatible", "configuration_changed", "configuration_changed"],
      );
      assert.equal(new Set(completed.map((record) => record.runtimeId)).size, 1);
      assert.equal(new Set(completed.map((record) => record.requestId)).size, 4);
      const executions = completed.map(
        (record) => record.executions as Array<{ event: string; queryId: string }>,
      );
      assert.deepEqual(
        executions.map((events) => events.map((event) => event.event)),
        [["query_created"], ["query_reused"], ["query_created"], ["query_created"]],
      );
      assert.equal(executions[0][0].queryId, executions[1][0].queryId);
      assert.notEqual(executions[1][0].queryId, executions[2][0].queryId);
      assert.notEqual(executions[2][0].queryId, executions[3][0].queryId);
      assert.equal(completed[0].configurationFingerprint, completed[3].configurationFingerprint);
      assert.equal(
        completed[3].previousConfigurationFingerprint,
        completed[2].configurationFingerprint,
      );
      assert.equal(completed[0].requestedModel, "opus");
      assert.equal(completed[0].resolvedModel, "claude-opus-5");
      assert.equal(completed[2].servedModel, "claude-fable-5-1");
      for (const record of completed) {
        assert.deepEqual(record.usage, {
          input: 2,
          cache_read: 17000,
          cache_creation: 0,
          output: 9,
        });
      }
      assert.doesNotMatch(JSON.stringify(logs), /private-|test-key|\bgo\b/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    assert.ok(
      logs.some(
        (record) => record.event === "runtime_close" && record.reason === "HTTP server shutdown",
      ),
    );
  });

  it("passes normalized models through the real core and switches a warm thread", async () => {
    const sdkModels: Array<string | undefined> = [];
    const logs: Array<Record<string, unknown>> = [];
    const server = createHttpServer({
      apiKey: KEY,
      supportedModels: [],
      log: (record) => logs.push(record),
      queryFactory: ({ options }) => {
        sdkModels.push(options?.model);
        const stream = [
          { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
          {
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "replayed" },
            },
          },
          { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
          {
            type: "stream_event",
            event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
          },
          { type: "stream_event", event: { type: "message_stop" } },
          {
            type: "result",
            subtype: "success",
            result: "replayed",
            is_error: false,
            modelUsage: {},
          },
        ] as unknown as SDKMessage[];
        return {
          async *[Symbol.asyncIterator]() {
            yield* stream;
          },
          initializationResult: async () => ({}),
          setMcpServers: async () => ({
            added: [] as string[],
            removed: [] as string[],
            errors: {},
          }),
          setModel: async () => {},
          interrupt: async () => ({}),
          close: () => {},
        } as unknown as Query;
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const post = (value: unknown) =>
        fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": KEY },
          body: JSON.stringify(value),
        });
      const first = await post({
        ...body(A),
        model: "vendor/claude-haiku-4-5-20251001",
      });
      assert.match(await first.text(), /replayed/);
      const second = await post({
        ...body(A, [
          { role: "user", content: "go" },
          { role: "assistant", content: [{ type: "text", text: "replayed" }] },
          { role: "user", content: "next" },
        ]),
        model: "claude-opus-5",
      });
      assert.match(await second.text(), /replayed/);
      assert.deepEqual(sdkModels, ["claude-haiku-4-5-20251001", "claude-opus-5"]);
      const completed = logs.filter((record) => record.event === "request_complete");
      assert.equal(completed[0]?.sync, "first");
      assert.equal(completed[0]?.reason, "first_request");
      assert.equal(completed[1]?.reason, "compatible");
      assert.notEqual(
        completed[0]?.configurationFingerprint,
        completed[1]?.configurationFingerprint,
      );
      const firstUsage = completed[0]?.usage as Record<string, unknown> | undefined;
      assert.equal(firstUsage?.cache_read, null);
      assert.equal(firstUsage?.cache_creation, null);
      assert.equal(completed[0]?.servedModel, null);
      assert.match(JSON.stringify(completed), /query_created/);
      assert.doesNotMatch(JSON.stringify(completed), /\bgo\b|test-key/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
