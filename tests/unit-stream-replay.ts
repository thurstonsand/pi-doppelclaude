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
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { Doppel } from "doppelclaude/doppel";
import { isCcRejectedToolName } from "doppelclaude/tool-names";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
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
  const c = new Doppel("stream-replay", "guest").context;
  const piStream = beginProjectedCommand(c, model);
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
  });
  runtime.test.finalizeCurrentResponse(c);
  await projected;
  return { events, ctx: c, results, capturedSessionId };
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
