/**
 * consumeQuery against real recorded SDK streams.
 *
 * The fixtures in tests/fixtures/sdk-streams/ are verbatim message sequences from
 * live Claude Code turns, captured by tests/lib/record-sdk-streams.ts. Nothing
 * here is hand-authored, so these cover the message shapes CC actually emits —
 * including ones we would not have thought to write, like the `system/status`
 * frames and the `rate_limit_event` every turn carries. Re-record on an SDK bump
 * and the diff is the contract change.
 *
 * The synthetic streams in the other unit suites stay synthetic on purpose: a
 * 429, a dead query, or a hallucinated tool name cannot be recorded on demand.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Query, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, AssistantMessage, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { type SessionEntry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import { Doppel } from "doppelclaude/doppel";
import { isCcRejectedToolName } from "doppelclaude/tool-names";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { thinkingDropNotice } from "pi-doppelclaude/thinking-drop";
import { beginProjectedCommand } from "./lib/native-response.js";

// `cost` matters: a recorded stream carries real usage, so consumeQuery reaches
// pi-ai's cost calculation, which the hand-built streams never exercise. Zeros are
// what buildModels ships (src/models.ts) since Claude Code billing is per-plan.
const [model] = projectCatalogModels(
  [
    {
      id: "claude-haiku-4-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<Api>,
  ],
  new Set(["claude-haiku-4-5"]),
);

const runtime = createBridgeRuntime({ providerSettings: { systemPromptMode: "claude-code" } });

function fixture(name: string): SDKMessage[] {
  const path = new URL(`./fixtures/sdk-streams/${name}.jsonl`, import.meta.url);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Replays a fixture through the real consumeQuery, collecting the pi-side events. */
async function replay(name: string, { toolNames = ["read"] }: { toolNames?: string[] } = {}) {
  const events: AssistantMessageEvent[] = [];
  const native: CoreResponseEvent[] = [];
  const c = new Doppel("stream-replay", "guest").context;
  const piStream = beginProjectedCommand(c, model, native);
  const projected = (async () => {
    for await (const event of piStream) events.push(event);
  })();
  // The map the provider path builds from the served tool list: SDK name → pi name.
  const customToolNameToPi = new Map(toolNames.map((n) => [`mcp__custom-tools__${n}`, n]));

  const messages = fixture(name);
  async function* stream() {
    for (const message of messages) yield message;
  }
  let capturedSessionId: string | undefined;
  const results: SDKResultMessage[] = [];
  await runtime.test.consumeQuery(stream() as unknown as Query, customToolNameToPi, model.id, c, {
    onResult: (message: SDKResultMessage) => results.push(message),
    onSessionId: (sessionId: string) => {
      capturedSessionId = sessionId;
    },
    onOutputCeiling() {},
  });
  runtime.test.finalizeCurrentResponse(c);
  await projected;
  return { events, native, ctx: c, results, capturedSessionId };
}

function finalMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.find((e) => e.type === "done");
  assert.ok(done, "the turn should finish");
  return done.message;
}

type Ctx = Awaited<ReturnType<typeof replay>>["ctx"];
const blocks = <T extends string>(ctx: Ctx, type: T) =>
  // biome-ignore lint/suspicious/noExplicitAny: narrowing recorded content by discriminant
  ctx.turnOutput.message.content.filter((b): b is any => b.type === type);

describe("replaying a recorded text-only turn", () => {
  it("produces the assistant text and a clean stop", async () => {
    const { ctx, events } = await replay("text");

    const text = blocks(ctx, "text")
      .map((b: { text: string }) => b.text)
      .join("")
      .trim();
    assert.equal(text, "ALPHA");
    assert.equal(ctx.turnOutput.message.stop_reason, "end_turn");
    assert.equal(ctx.turnSawToolCall, false);
    assert.ok(
      events.some((e) => e.type === "text_delta"),
      "pi should have seen streaming deltas",
    );
  });

  it("reports usage and captures the session id", async () => {
    const { ctx, results, capturedSessionId } = await replay("text");

    assert.ok(ctx.turnOutput.message.usage.output_tokens > 0, "output tokens");
    assert.ok(
      ctx.turnOutput.message.usage.input_tokens +
        ctx.turnOutput.message.usage.cache_read_input_tokens +
        ctx.turnOutput.message.usage.cache_creation_input_tokens >
        0,
      "prompt tokens",
    );
    assert.equal(results.length, 1);
    assert.match(capturedSessionId ?? "", /^[0-9a-f-]{36}$/);
  });
});

describe("replaying a recorded single-tool turn", () => {
  it("surfaces the tool call under its pi name", async () => {
    const { ctx } = await replay("single-tool");

    const calls = blocks(ctx, "tool_use");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "read", "SDK's mcp__custom-tools__read must arrive as pi's read");
    assert.ok(calls[0].id.startsWith("toolu_"));
    assert.equal(ctx.turnSawToolCall, true);
    assert.ok(ctx.shownToolCallIds.has(calls[0].id));
  });
});

describe("replaying a recorded parallel-tool turn", () => {
  it("keeps every parallel call, in emission order", async () => {
    const { ctx } = await replay("parallel-tools");

    const calls = blocks(ctx, "tool_use");
    assert.ok(calls.length >= 2, `expected a parallel batch, got ${calls.length}`);
    for (const call of calls) assert.equal(call.name, "read");
    assert.equal(new Set(calls.map((c) => c.id)).size, calls.length, "no duplicate ids");
    for (const call of calls) assert.ok(ctx.shownToolCallIds.has(call.id));
  });

  // Recorded streams are the check that the names CC really sends are the ones
  // the map is keyed on. A name the map lacks must reach pi mangled — never as
  // a bare pi name or a CC builtin the bridge does not serve.
  it("mangles every call when the served tool list is empty", async () => {
    const { ctx } = await replay("parallel-tools", { toolNames: [] });

    const calls = blocks(ctx, "tool_use");
    assert.ok(calls.length >= 2, "the recorded calls still surface");
    for (const call of calls) {
      assert.ok(
        isCcRejectedToolName(call.name),
        `unserved name must arrive mangled, got "${call.name}"`,
      );
    }
  });
});

describe("replaying a recorded thinking turn", () => {
  it("streams the signed thinking block to pi ahead of the answer", async () => {
    const { ctx, events } = await replay("thinking");

    const content = ctx.turnOutput.message.content;
    assert.deepEqual(
      content.map((b) => b.type),
      ["thinking", "text"],
    );
    const [thinking] = blocks(ctx, "thinking");
    assert.match(thinking.thinking, /1,?048,?576/);
    assert.ok(thinking.signature.length > 0, "the signature must survive for replay to the API");
    assert.equal(blocks(ctx, "text")[0].text.trim(), "31");
    assert.ok(
      events.some((e) => e.type === "thinking_delta"),
      "pi should have seen streaming thinking deltas",
    );
  });
});

// The fixture resumes a saved thinking turn whose first prompt was edited, so the API dropped that
// turn's thinking from the request and said why. Only what it reported may reach the user.
describe("replaying a recorded turn the API dropped thinking from", () => {
  const dropped = {
    type: "thinking_dropped",
    path: "messages.2.content.0",
    reason: "prefix_binding_mismatch",
  };

  it("records the API's report on pi's message, verbatim", async () => {
    const message = finalMessage((await replay("thinking-dropped")).events);
    assert.deepEqual(
      message.diagnostics?.map(({ type, details }) => ({ type, details })),
      [{ type: "anthropic_input_transformations", details: { transformations: [dropped] } }],
    );
  });

  it("serves the report in the native message_start the HTTP frontend streams", async () => {
    const { native } = await replay("thinking-dropped");
    const start = native.find((e) => e.type === "message_start");
    assert.ok(start);
    assert.deepEqual((start.message as { input_transformations?: unknown }).input_transformations, [
      dropped,
    ]);
  });

  it("adds no diagnostic when the API reports nothing dropped", async () => {
    // Every recorded turn carries input_transformations, as [] when nothing was dropped.
    const message = finalMessage((await replay("thinking")).events);
    assert.equal(message.diagnostics, undefined);
  });

  describe("telling the user", () => {
    const entry = (id: string, message: AssistantMessage): SessionEntry => ({
      type: "message",
      id,
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message,
    });
    const quiet = (message: AssistantMessage): AssistantMessage => ({
      ...message,
      diagnostics: [],
    });

    it("tells them what the API said when they have not chosen pi's own notice", async () => {
      const message = finalMessage((await replay("thinking-dropped")).events);
      assert.deepEqual(thinkingDropNotice([entry("reply", message)], "reply", undefined), {
        count: 1,
        reasons: ["prefix_binding_mismatch"],
      });
    });

    it("leaves it to pi once they have set reasoningDrops, including migrated settings", async () => {
      const branch = [entry("reply", finalMessage((await replay("thinking-dropped")).events))];
      for (const saved of [
        { notices: { reasoningDrops: true } },
        { showCacheMissNotices: true, notices: { reasoningDrops: false } },
        { showCacheMissNotices: false },
      ]) {
        const settings = SettingsManager.fromStorage({
          withLock: (scope, read) => {
            if (scope === "global") read(JSON.stringify(saved));
          },
        }).getSettings();
        assert.equal(
          thinkingDropNotice(branch, "reply", settings.notices?.reasoningDrops),
          undefined,
        );
      }
    });

    it("stays quiet when the previous reply already reported as many drops", async () => {
      const message = finalMessage((await replay("thinking-dropped")).events);
      const branch = [entry("before", message), entry("reply", message)];
      assert.equal(thinkingDropNotice(branch, "reply", undefined), undefined);
      const afterQuiet = [entry("before", quiet(message)), entry("reply", message)];
      assert.ok(thinkingDropNotice(afterQuiet, "reply", undefined));
    });
  });
});
