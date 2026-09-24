import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { createHttpServer } from "http-doppelclaude";

// A client answering a tool_use may split the results and mid-turn user text across two user
// messages; the day-one 0.12.3 audit saw that shape rebuilt cold. Each case
// sends a first request whose mocked reply is a tool_use turn (so the bridge expects tool results
// next), then a second request shaped like one of the client behaviours under suspicion.

const KEY = "test-key";
const SERVED_MODEL = "claude-served-9-20990101";

function message(content: Message["content"], stop: Message["stop_reason"]): Message {
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
  stop: Message["stop_reason"],
): AsyncIterable<CoreResponseEvent> {
  const value = { ...message(content, stop), model: SERVED_MODEL };
  yield { type: "message_start", message: { ...value, content: [] } };
  for (const [index, block] of content.entries()) {
    yield { type: "content_block_start", index, content_block: block };
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

type Seen = { kind: "turn" | "replay"; request: RuntimeRequest };

const TOOL_USE_REPLY = [
  { type: "tool_use", id: "sdk-1", name: "lookup", input: { n: 1 } },
  { type: "tool_use", id: "sdk-2", name: "lookup", input: { n: 2 } },
] as Message["content"];

function fakeRuntime(seen: Seen[], rebuilds: string[]) {
  return {
    turn(request: RuntimeRequest) {
      seen.push({ kind: "turn", request });
      return native(TOOL_USE_REPLY, "tool_use");
    },
    replay(request: RuntimeRequest) {
      seen.push({ kind: "replay", request });
      return native([{ type: "text", text: "done" }] as Message["content"], "end_turn");
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

function body(thread: string, messages: unknown[]) {
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

async function harness() {
  const seen: Seen[] = [];
  const rebuilds: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const server = createHttpServer({
    apiKey: KEY,
    supportedModels: [],
    log: (record) => logs.push(record),
    createRuntime: () => fakeRuntime(seen, rebuilds) as never,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  return {
    seen,
    rebuilds,
    logs,
    post: async (value: unknown) => {
      const response = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: JSON.stringify(value),
      });
      return { status: response.status, text: await response.text() };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ASSISTANT_ECHO = {
  role: "assistant",
  content: [
    { type: "tool_use", id: "client-a", name: "lookup", input: { n: 1 } },
    { type: "tool_use", id: "client-b", name: "lookup", input: { n: 2 } },
  ],
};
const RESULTS = [
  { type: "tool_result", tool_use_id: "client-a", content: "one" },
  { type: "tool_result", tool_use_id: "client-b", content: "two" },
];

type Expectation = {
  reason: string;
  sync: string;
  coldReplay: boolean;
  kind: "turn" | "replay";
};

const cases: Array<{ label: string; second: unknown[]; expect: Expectation }> = [
  {
    label: "plain continuation: results only (+2)",
    second: [{ role: "user", content: "go" }, ASSISTANT_ECHO, { role: "user", content: RESULTS }],
    expect: { reason: "compatible", sync: "compatible", coldReplay: false, kind: "turn" },
  },
  {
    label: "merged steer: results and text in one user message (+2)",
    second: [
      { role: "user", content: "go" },
      ASSISTANT_ECHO,
      { role: "user", content: [...RESULTS, { type: "text", text: "actually, stop and do X" }] },
    ],
    expect: { reason: "compatible", sync: "compatible", coldReplay: false, kind: "turn" },
  },
  {
    label: "split steer: results message then separate user text (+3, the day-one shape)",
    second: [
      { role: "user", content: "go" },
      ASSISTANT_ECHO,
      { role: "user", content: RESULTS },
      { role: "user", content: "actually, stop and do X" },
    ],
    expect: { reason: "compatible", sync: "compatible", coldReplay: false, kind: "turn" },
  },
  {
    label: "split steer with a mutated assistant echo must still diverge",
    second: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "client-a", name: "lookup", input: { n: 99 } },
          { type: "tool_use", id: "client-b", name: "lookup", input: { n: 2 } },
        ],
      },
      { role: "user", content: RESULTS },
      { role: "user", content: "actually, stop and do X" },
    ],
    expect: { reason: "history_diverged", sync: "rebuild", coldReplay: false, kind: "turn" },
  },
  {
    label: "split steer whose results message also carries text must still diverge",
    second: [
      { role: "user", content: "go" },
      ASSISTANT_ECHO,
      { role: "user", content: [...RESULTS, { type: "text", text: "note" }] },
      { role: "user", content: "actually, stop and do X" },
    ],
    expect: { reason: "history_diverged", sync: "rebuild", coldReplay: false, kind: "turn" },
  },
  {
    label: "compaction: shorter history ending in a tool result replays cold",
    second: [
      { role: "user", content: "summary of everything so far" },
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "x" }] },
    ],
    expect: { reason: "history_diverged", sync: "rebuild", coldReplay: true, kind: "replay" },
  },
];

describe("HTTP history matching after a tool_use reply", () => {
  for (const [index, variant] of cases.entries()) {
    it(variant.label, async () => {
      const thread = `T-${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`;
      const app = await harness();
      try {
        const first = await app.post(body(thread, [{ role: "user", content: "go" }]));
        assert.equal(first.status, 200);
        assert.match(first.text, /tool_use/);
        const second = await app.post(body(thread, variant.second));
        assert.equal(second.status, 200, second.text);
        const log = app.logs.filter((record) => record.event === "request_complete")[1];
        assert.equal(log.outcome, "success");
        assert.equal(log.messageCount, variant.second.length);
        assert.deepEqual(
          {
            reason: log.reason,
            sync: log.sync,
            coldReplay: log.coldReplay,
            kind: app.seen[1].kind,
          },
          variant.expect,
        );
        assert.equal(app.seen[1].request.messages.length, variant.second.length);
      } finally {
        await app.close();
      }
    });
  }

  it("a continuation after an accepted split steer stays compatible", async () => {
    const thread = "T-99999999-1111-4111-8111-111111111111";
    const app = await harness();
    try {
      await app.post(body(thread, [{ role: "user", content: "go" }]));
      const steered = [
        { role: "user", content: "go" },
        ASSISTANT_ECHO,
        { role: "user", content: RESULTS },
        { role: "user", content: "actually, stop and do X" },
      ];
      await app.post(body(thread, steered));
      const third = await app.post(
        body(thread, [
          ...steered,
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "client-c", name: "lookup", input: { n: 1 } },
              { type: "tool_use", id: "client-d", name: "lookup", input: { n: 2 } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "client-c", content: "three" },
              { type: "tool_result", tool_use_id: "client-d", content: "four" },
            ],
          },
        ]),
      );
      assert.equal(third.status, 200, third.text);
      const logs = app.logs.filter((record) => record.event === "request_complete");
      assert.deepEqual(
        logs.map((log) => log.reason),
        ["first_request", "compatible", "compatible"],
      );
      assert.equal(app.rebuilds.length, 0);
    } finally {
      await app.close();
    }
  });
});
