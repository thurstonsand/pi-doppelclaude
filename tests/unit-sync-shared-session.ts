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
import { getSessionPath } from "cc-session-io";
import { describeSyncReason, planSessionSync } from "doppelclaude/doppel";
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
