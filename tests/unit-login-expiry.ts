/**
 * Claude Code reports when its stored claude.ai login ends. A login that has ended fails
 * every turn until the user signs in again, so pi warns once a session while the end is
 * close enough to act on. Drives the real runtime with a fake SDK query.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type Api,
  type Model,
  normalizeContext,
  type Message as PiMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PushQueue } from "doppelclaude/query-state";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { record } from "./lib/turns.js";

const [fakeModel] = projectCatalogModels(
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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WARNING = /^Claude Code's sign-in ends .+; run `claude auth login` to renew it$/u;

function answer(credentialExpiresAt: string | undefined): SDKMessage[] {
  return [
    { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { type: "stream_event", event: { type: "message_stop" } },
    {
      type: "result",
      subtype: "success",
      result: "ok",
      is_error: false,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      ...(credentialExpiresAt ? { credential_expires_at: credentialExpiresAt } : {}),
    },
  ] as unknown as SDKMessage[];
}

function makeHarness(credentialExpiresAt: () => string | undefined) {
  const warnings: string[] = [];
  const runtime = createPiBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
    queryFactory: () => {
      const queue = new PushQueue<SDKMessage>();
      for (const message of answer(credentialExpiresAt())) queue.push(message);
      queue.end();
      return {
        [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
        initializationResult: async () => ({}),
        setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
        setModel: async () => {},
        interrupt: async () => ({}),
        close: () => queue.end(),
      } as unknown as Query;
    },
  });
  const startSession = () =>
    runtime.setHost({
      ui: { notify: (message: string) => warnings.push(message) } as unknown as ExtensionUIContext,
      appendEntry() {},
    });
  startSession();
  const turn = () =>
    record(
      runtime.stream(
        fakeModel,
        normalizeContext({
          systemPrompt: "",
          messages: [{ role: "user", content: "go", timestamp: 0 }] as PiMessage[],
          tools: [],
        }),
      ),
    ).done;
  return { warnings, turn, startSession };
}

describe("login expiry warning", () => {
  it("warns once a session while the login ends within ten days", async () => {
    const harness = makeHarness(() => new Date(Date.now() + 10 * DAY - HOUR).toISOString());

    await harness.turn();
    await harness.turn();
    assert.equal(harness.warnings.length, 1);
    assert.match(harness.warnings[0], WARNING);

    harness.startSession();
    await harness.turn();
    assert.equal(harness.warnings.length, 2, "a new session was not warned");
  });

  it("stays quiet while the end is further off, and for credentials with no end", async () => {
    let expiresAt: string | undefined = new Date(Date.now() + 10 * DAY + HOUR).toISOString();
    const harness = makeHarness(() => expiresAt);
    await harness.turn();
    expiresAt = undefined;
    await harness.turn();
    assert.deepEqual(harness.warnings, []);
  });
});
