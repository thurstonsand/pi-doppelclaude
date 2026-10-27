/**
 * Regression tests for the session reuse decisions a doppel's sync makes.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { type ContentBlock, createSession, getSessionPath } from "cc-session-io";
import { createBridgeRuntime as createCoreRuntime } from "doppelclaude/bridge-runtime";
import { describeSyncReason, planSessionSync } from "doppelclaude/doppel";
import { BridgeSessionStore } from "doppelclaude/session-store";
import { convertPiMessages } from "pi-doppelclaude/convert";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";

const runtime = createBridgeRuntime({
  providerSettings: { systemPromptMode: "claude-code" },
});
void runtime.designateHost("host-session-id");
const { test } = runtime;

describe("session sync planning", () => {
  afterEach(() => {
    test.resetSessions();
  });

  it("plans a clean start when no session exists", () => {
    const plan = planSessionSync([{ role: "user", content: "hello" }], null);
    assert.equal(plan.path, "clean-start");
    assert.equal(plan.previousSession, null);
    assert.equal(plan.reason.kind, "no-session");
  });

  it("plans reuse for a trailing assistant without mutating the session", () => {
    const session = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 };
    const plan = planSessionSync(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: "next" },
      ] as MessageParam[],
      session,
    );
    assert.equal(plan.path, "reuse");
    assert.equal(plan.advanceCursor, true);
    assert.equal(session.cursor, 1);
    assert.equal(plan.reason.kind, "trailing-assistant");
  });

  it("plans rebuild for divergent history", () => {
    const session = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 };
    const plan = planSessionSync(
      [
        { role: "user", content: "first" },
        { role: "user", content: "foreign turn" },
        { role: "assistant", content: [{ type: "text", text: "foreign answer" }] },
        { role: "user", content: "next" },
      ] as MessageParam[],
      session,
    );
    assert.equal(plan.path, "rebuild");
    assert.deepEqual(plan.reason, { kind: "missed-messages", missed: 2 });
  });

  // Every rebuild reports the condition that chose it. Without this the only
  // record of a forced rebuild was a separate log line from whichever site set
  // the flag, and the two could only be tied together by their shared process.
  it("names the cause a forced rebuild was marked with", () => {
    const plan = planSessionSync(
      [
        { role: "user", content: "first" },
        { role: "user", content: "next" },
      ] as MessageParam[],
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        cursor: 1,
        rebuildReason: "session_compact:manual",
      },
    );
    assert.equal(plan.path, "rebuild");
    assert.equal(describeSyncReason(plan.reason), "forced(session_compact:manual)");
  });

  it("reports the cursor and history length when the history is shorter than the cursor", () => {
    const plan = planSessionSync(
      [
        { role: "user", content: "first" },
        { role: "user", content: "next" },
      ] as MessageParam[],
      { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 42 },
    );
    assert.equal(plan.path, "rebuild");
    assert.equal(describeSyncReason(plan.reason), "history-shrank(cursor=42 priors=1)");
  });

  it("rebuilds into the store without writing Claude's project directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-store-"));
    try {
      const messages = [
        { role: "user", content: "remember one", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "one" }],
          api: "doppelclaude",
          provider: "doppelclaude",
          model: "claude-haiku-4-5",
          timestamp: 2,
        },
        { role: "user", content: "next", timestamp: 3 },
      ] as unknown as PiMessage[];
      const nativeMessages = convertPiMessages(messages).anthropicMessages as MessageParam[];
      const first = test.syncHostSession(nativeMessages, cwd);
      assert.equal(first.path, "rebuild");
      assert.ok(first.sessionId);
      assert.equal(test.getStoredSession(first.sessionId).length, 2);
      assert.equal(existsSync(getSessionPath(first.sessionId, cwd)), false);

      test.setHostSession({ sessionId: first.sessionId, cursor: 0, rebuildReason: "test" });
      const second = test.syncHostSession(nativeMessages, cwd);
      assert.equal(second.sessionId, first.sessionId);
      assert.equal(test.getStoredSession(first.sessionId).length, 2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("plans a rebuild when the conversation rewound behind the cursor", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
    try {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      test.setHostSession({ sessionId, cursor: 42 });

      const messages = [
        { role: "user", content: "first", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "one" }],
          api: "doppelclaude",
          provider: "doppelclaude",
          model: "claude-haiku-4-5",
          timestamp: 2,
        },
        { role: "user", content: "take that back", timestamp: 3 },
      ] as unknown as PiMessage[];
      const nativeMessages = convertPiMessages(messages).anthropicMessages as MessageParam[];
      const result = test.syncHostSession(nativeMessages, cwd);

      assert.equal(
        result.path,
        "rebuild",
        "a rewound history must replace the transcript instead of resuming a session that ran past it",
      );
      assert.equal(result.sessionId, sessionId, "the rebuild must keep the session id stable");
      assert.deepEqual(test.getHostSession(), { sessionId, cursor: 2 });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// A rebuilt transcript must render the prompt prefix the live query sent, or the prompt cache
// breaks at the first difference. Claude Code keeps its injected context (environment, model,
// date) as attachment records after the message it rode in on, and renders an empty tool result
// as a fixed sentence; both literals here are what a live Claude Code query sent upstream.
describe("rebuild rendering", () => {
  const cwd = "/tmp/rebuild-rendering";
  // Two user messages open the history (pi can send a steer behind a prompt), so the context the
  // live query attached to its first prompt belongs after the second of them.
  const history = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "and a steer" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu.1", name: "mcp__custom-tools__lookup", input: {} }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu.1", content: [{ type: "text", text: "" }] },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "nothing there" }] },
    { role: "user", content: [{ type: "text", text: "next" }] },
  ] as MessageParam[];

  function liveTranscript() {
    const live = createSession({ projectPath: cwd });
    live.addUserMessage([{ type: "text", text: "first" }]);
    live.addAttachment({ type: "environment", snapshot: { workingDirectory: "/w" } });
    live.addAttachment({ type: "date", date: "2026-10-17" });
    live.addAttachment({ type: "prompt_snapshot", systemPrompt: ["an older system prompt"] });
    live.addAssistantMessage([{ type: "text", text: "earlier answer" }]);
    live.addUserMessage([{ type: "text", text: "after midnight" }]);
    live.addAttachment({ type: "date", date: "2026-10-18", changed: true });
    live.addAttachment({
      type: "total_tokens_reminder",
      text: "<total_tokens>14993274 tokens left</total_tokens>",
    });
    live.addAssistantMessage([{ type: "text", text: "later answer" }]);
    return live;
  }

  function shape(records: ReadonlyArray<Record<string, unknown>>) {
    return records.flatMap((record) => {
      if (record.type === "attachment")
        return [`attachment:${(record.attachment as { type: string }).type}`];
      if (record.type !== "user" && record.type !== "assistant") return [];
      const content = (record.message as { content: unknown }).content;
      const result = Array.isArray(content)
        ? content.find((block: { type: string }) => block.type === "tool_result")
        : undefined;
      return [result ? `user:tool_result:${JSON.stringify(result.content)}` : String(record.type)];
    });
  }

  // Four records land (only the prompt snapshot, which Claude Code never renders, stays behind),
  // one empty result is rendered, and the dotted tool id is the one Claude Code would reject.
  const counts = {
    contextAttachments: 4,
    emptyToolResults: 1,
    sanitizedToolIds: 1,
    synthesizedToolResults: 0,
    droppedToolResults: 0,
    turnBoundaries: 0,
    skippedTurnBoundaries: 0,
  };

  const expected = [
    "user",
    "user",
    "attachment:environment",
    "attachment:date",
    "assistant",
    'user:tool_result:"(mcp__custom-tools__lookup completed with no output)"',
    "attachment:date",
    "attachment:total_tokens_reminder",
    "assistant",
  ];

  it("keeps the doppel's own context records where its transcript had them", () => {
    const store = new BridgeSessionStore();
    const live = liveTranscript();
    store.replace(live.sessionId, live.records);
    const runtime = createCoreRuntime({ sessionStore: store });
    void runtime.designateHost("host-session-id");
    runtime.test.setHostSession({ sessionId: live.sessionId, cursor: 4, rebuildReason: "test" });

    const result = runtime.test.syncHostSession(history, cwd);

    assert.equal(result.path, "rebuild");
    const { divergence: _own, ...rebuild } = result.rebuild ?? {};
    assert.deepEqual(rebuild, { contextSource: "own", ...counts });
    assert.deepEqual(shape(store.load(live.sessionId) ?? []), expected);
  });

  it("takes the context records from a sibling transcript when the doppel has none", () => {
    const live = liveTranscript();
    const siblingStore = new BridgeSessionStore();
    siblingStore.replace(live.sessionId, live.records);
    const store = new BridgeSessionStore();
    const runtime = createCoreRuntime({
      sessionStore: store,
      hostSiblingTranscript: () => siblingStore.load(live.sessionId),
    });
    void runtime.designateHost("host-session-id");

    const result = runtime.test.syncHostSession(history, cwd);

    assert.equal(result.path, "rebuild");
    const { divergence: _sibling, ...rebuild } = result.rebuild ?? {};
    assert.deepEqual(rebuild, { contextSource: "sibling", ...counts });
    assert.ok(result.sessionId);
    assert.deepEqual(shape(store.load(result.sessionId) ?? []), expected);
  });

  // A query started on tool results the history already held: Claude Code wrote its synthetic
  // turn and the replay prompt between those results and the reply, as a live query did.
  function replayTranscript() {
    const live = createSession({ projectPath: cwd });
    live.addUserMessage([{ type: "text", text: "first" }]);
    live.addUserMessage([{ type: "text", text: "and a steer" }]);
    live.addAssistantMessage([
      { type: "tool_use", id: "toolu.1", name: "mcp__custom-tools__lookup", input: {} },
    ]);
    live.addToolResults([{ toolUseId: "toolu_1", content: "(lookup completed with no output)" }]);
    live.addAssistantMessage([{ type: "text", text: "No response requested." }], {
      model: "<synthetic>",
    });
    live.addUserMessage("Continue the pending task.");
    live.addAttachment({ type: "date", date: "2026-10-18" });
    live.addAssistantMessage([{ type: "text", text: "nothing there" }]);
    live.addUserMessage([{ type: "text", text: "next" }]);
    return live;
  }

  it("puts a replay's turn boundary back where the transcript had it", () => {
    const store = new BridgeSessionStore();
    const live = replayTranscript();
    store.replace(live.sessionId, live.records);
    const runtime = createCoreRuntime({ sessionStore: store });
    void runtime.designateHost("host-session-id");
    runtime.test.setHostSession({ sessionId: live.sessionId, cursor: 4, rebuildReason: "test" });

    const result = runtime.test.syncHostSession(history, cwd);

    assert.equal(result.rebuild?.turnBoundaries, 1);
    assert.equal(result.rebuild?.skippedTurnBoundaries, 0);
    assert.deepEqual(shape(store.load(live.sessionId) ?? []), [
      "user",
      "user",
      "assistant",
      'user:tool_result:"(mcp__custom-tools__lookup completed with no output)"',
      "assistant",
      "user",
      "attachment:date",
      "assistant",
    ]);
    const restored = (store.load(live.sessionId) ?? []).filter(
      (record) => record.type === "user" || record.type === "assistant",
    );
    assert.deepEqual(
      restored.slice(4, 6).map((record) => (record.message as { content: unknown }).content),
      [[{ type: "text", text: "No response requested." }], "Continue the pending task."],
    );
  });

  it("leaves a boundary out when the history's results no longer stand alone", () => {
    const store = new BridgeSessionStore();
    const live = replayTranscript();
    store.replace(live.sessionId, live.records);
    const runtime = createCoreRuntime({ sessionStore: store });
    void runtime.designateHost("host-session-id");
    runtime.test.setHostSession({ sessionId: live.sessionId, cursor: 4, rebuildReason: "test" });
    // The client folded a steer into the results message, so the live boundary has no place.
    const steered = history.map((message, index) =>
      index === 3
        ? {
            ...message,
            content: [...(message.content as unknown[]), { type: "text", text: "a steer" }],
          }
        : message,
    ) as MessageParam[];

    const result = runtime.test.syncHostSession(steered, cwd);

    assert.equal(result.rebuild?.turnBoundaries, 0);
    assert.equal(result.rebuild?.skippedTurnBoundaries, 1);
    assert.equal(
      (store.load(live.sessionId) ?? []).filter(
        (record) =>
          record.type === "assistant" &&
          JSON.stringify((record.message as { content: unknown }).content).includes(
            "No response requested.",
          ),
      ).length,
      0,
    );
  });

  // The live turn kept its signed thinking; a client that strips it from history rebuilds a
  // transcript whose cached prefix ends at that turn. The steer Claude Code wrote as its own
  // record renders in the same request message the history folds it into.
  function thinkingTranscript() {
    const live = createSession({ projectPath: cwd });
    live.addUserMessage([{ type: "text", text: "q" }]);
    live.addUserMessage([{ type: "text", text: "a steer" }]);
    live.addAssistantMessage([
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "a" },
    ]);
    live.addUserMessage([{ type: "text", text: "r" }]);
    live.addAssistantMessage([{ type: "text", text: "b" }]);
    return live;
  }

  function rebuildDivergence(firstAnswer: unknown[]) {
    const store = new BridgeSessionStore();
    const live = thinkingTranscript();
    store.replace(live.sessionId, live.records);
    const runtime = createCoreRuntime({ sessionStore: store });
    void runtime.designateHost("host-session-id");
    runtime.test.setHostSession({ sessionId: live.sessionId, cursor: 1, rebuildReason: "test" });
    const result = runtime.test.syncHostSession(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "q" },
            { type: "text", text: "a steer" },
          ],
        },
        { role: "assistant", content: firstAnswer },
        { role: "user", content: [{ type: "text", text: "r" }] },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ] as MessageParam[],
      cwd,
    );
    assert.equal(result.path, "rebuild");
    return result.rebuild?.divergence;
  }

  it("names the first block a rebuild renders differently from the live transcript", () => {
    assert.deepEqual(rebuildDivergence([{ type: "text", text: "a" }]), {
      sourceGroups: 4,
      rebuiltGroups: 4,
      matchedGroups: 1,
      at: { role: "assistant", block: 0, sourceType: "thinking", rebuiltType: "text", fields: [] },
    });
  });

  it("reports no divergence when the blocks differ only in key order", () => {
    assert.deepEqual(
      rebuildDivergence([
        { signature: "sig", thinking: "hmm", type: "thinking" },
        { text: "a", type: "text" },
      ]),
      { sourceGroups: 4, rebuiltGroups: 4, matchedGroups: 4, at: null },
    );
  });

  it("reports no divergence for tool ids and decoration the prompt never carries", () => {
    const store = new BridgeSessionStore();
    const live = createSession({ projectPath: cwd });
    live.addUserMessage([{ type: "text", text: "q" }]);
    live.addAssistantMessage([
      {
        type: "tool_use",
        id: "toolu_live",
        name: "mcp__custom-tools__read",
        input: { path: "a" },
        caller: { type: "direct" },
      } as ContentBlock,
    ]);
    live.addToolResults([{ toolUseId: "toolu_live", content: "A" }]);
    live.addAssistantMessage([{ type: "text", text: "done" }]);
    store.replace(live.sessionId, live.records);
    const runtime = createCoreRuntime({ sessionStore: store });
    void runtime.designateHost("host-session-id");
    runtime.test.setHostSession({ sessionId: live.sessionId, cursor: 1, rebuildReason: "test" });

    const result = runtime.test.syncHostSession(
      [
        { role: "user", content: [{ type: "text", text: "q" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "amp_1",
              name: "mcp__custom-tools__read",
              input: { path: "a" },
            },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "amp_1", content: "A" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ] as MessageParam[],
      cwd,
    );

    assert.deepEqual(result.rebuild?.divergence, {
      sourceGroups: 4,
      rebuiltGroups: 4,
      matchedGroups: 4,
      at: null,
    });
  });

  it("counts the results the tool-pairing repair wrote and dropped", () => {
    const runtime = createCoreRuntime({ sessionStore: new BridgeSessionStore() });
    void runtime.designateHost("host-session-id");

    const result = runtime.test.syncHostSession(
      [
        { role: "user", content: [{ type: "text", text: "q" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "t", input: {} },
            { type: "tool_use", id: "b", name: "t", input: {} },
          ],
        },
        { role: "user", content: [{ type: "text", text: "never mind" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "zz", content: "x" }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [{ type: "text", text: "next" }] },
      ] as MessageParam[],
      cwd,
    );

    assert.equal(result.rebuild?.synthesizedToolResults, 2);
    assert.equal(result.rebuild?.droppedToolResults, 1);
  });
});
