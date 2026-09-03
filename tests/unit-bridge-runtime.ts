/**
 * Proves each createBridgeRuntime() owns its query/session/store state in its
 * own closure — two runtimes cannot bleed state into each other.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { PushQueue } from "../src/query-state.js";
import type { SessionStoreWriter } from "../src/session-store.js";

function makeRuntime() {
  const runtime = createBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
  });
  // Every runtime here stands in for one pi session, which is its own host.
  void runtime.designateHost("host-session-id");
  return runtime;
}

describe("bridge runtime isolation", () => {
  it("owns an independent host query context per runtime", async () => {
    const a = makeRuntime();
    const b = makeRuntime();
    assert.notStrictEqual(a.test.hostContext, b.test.hostContext);

    a.test.hostContext.latestCursor = 99;
    const blocked = a.test.hostContext.blockOnToolResult("t1", "read");

    assert.strictEqual(b.test.hostContext.latestCursor, 0);
    assert.strictEqual(b.test.hostContext.pendingToolCallCount, 0);

    a.test.hostContext.releasePendingToolCalls("Query ended");
    assert.deepEqual((await blocked).content, [{ type: "text", text: "Query ended" }]);
  });

  it("does not bleed host-session state between runtimes", () => {
    const a = makeRuntime();
    const b = makeRuntime();

    a.test.setHostSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 7 });
    assert.equal(b.test.getHostSession(), null);
    assert.equal(a.test.getHostSession().sessionId, "11111111-1111-4111-8111-111111111111");

    // Resetting one runtime must not touch the other's session.
    b.test.resetSessions();
    assert.equal(a.test.getHostSession().cursor, 7);
  });

  it("keeps transcript stores independent", () => {
    const a = makeRuntime();
    const b = makeRuntime();
    const cwd = mkdtempSync(join(tmpdir(), "bridge-runtime-store-"));
    try {
      const messages = [
        { role: "user", content: "remember", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "doppelclaude",
          provider: "doppelclaude",
          model: "claude-haiku-4-5",
          timestamp: 2,
        },
        { role: "user", content: "next", timestamp: 3 },
      ] as unknown as PiMessage[];
      const result = a.test.syncHostSession(messages, cwd);
      assert.equal(result.path, "rebuild");
      assert.ok(a.test.getStoredSession(result.sessionId).length > 0);

      // The second runtime has never seen this session.
      assert.equal(b.test.getStoredSession(result.sessionId), null);
      assert.equal(b.test.getHostSession(), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("drains completed queries without force-closing them", async () => {
    const runtime = makeRuntime();
    const context = runtime.test.hostContext;
    let forceClosed = false;
    const query = Object.create(null) as Query;
    query.close = () => {
      forceClosed = true;
    };
    context.activeQuery = query;
    context.inputQueue = new PushQueue();
    let writerClosed = false;
    const writer = Object.create(null) as SessionStoreWriter;
    writer.close = () => {
      writerClosed = true;
    };
    writer.invalidate = () => {
      throw new Error("drain must not invalidate the writer");
    };
    context.sessionStoreWriter = writer;
    let finishQuery: () => void;
    context.completion = new Promise<void>((resolve) => {
      finishQuery = resolve;
    });

    const closing = runtime.test.closeQueryContext(context, "completed", "drain");
    assert.equal(forceClosed, false);
    assert.equal(writerClosed, false, "writer closed before natural EOF");
    finishQuery();
    await closing;
    assert.equal(forceClosed, false);
    assert.equal(writerClosed, true, "writer did not close after natural EOF");
  });

  it("force-closes and fences unsafe queries before their consumer exits", async () => {
    const runtime = makeRuntime();
    const context = runtime.test.hostContext;
    let forceClosed = false;
    let writerClosed = false;
    const query = Object.create(null) as Query;
    query.close = () => {
      forceClosed = true;
    };
    context.activeQuery = query;
    context.inputQueue = new PushQueue();
    const writer = Object.create(null) as SessionStoreWriter;
    writer.close = () => {
      writerClosed = true;
    };
    writer.invalidate = () => {
      writerClosed = true;
    };
    context.sessionStoreWriter = writer;
    let finishQuery: () => void;
    context.completion = new Promise<void>((resolve) => {
      finishQuery = resolve;
    });
    runtime.test.setHostSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 });

    const closing = runtime.test.closeQueryContext(context, "unsafe", "force");
    assert.equal(forceClosed, true);
    assert.equal(writerClosed, true);
    assert.equal(runtime.test.getHostSession().rebuildReason, "force-close:unsafe");
    finishQuery();
    await closing;
  });

  it("does not replay a dead query's rejection to the next caller that closes", async () => {
    const runtime = makeRuntime();
    const context = runtime.test.hostContext;
    context.persistent = true;
    const query = Object.create(null) as Query;
    query.close = () => {};
    context.activeQuery = query;
    context.inputQueue = new PushQueue();
    let killQuery: (error: Error) => void;
    const completion = new Promise<void>((_resolve, reject) => {
      killQuery = reject;
    });
    context.completion = completion;
    completion.catch(() => {});

    // The child dies on its own, and the consumer's own close absorbs the rejection.
    const closing = runtime.test.closeQueryContext(context, "child exited", "force");
    killQuery(new Error("Claude Code process exited with code 1"));
    await closing;

    // A later provider switch has nothing left to close and must not inherit that failure.
    await runtime.closePersistent("provider switch");
  });

  it("reuses an interrupted query only after an empty receipt and terminal abort metadata", () => {
    const runtime = makeRuntime();
    const context = runtime.test.hostContext;
    context.persistent = true;
    context.turnAborted = true;
    context.turnInterruptReceiptReceived = true;
    context.turnInterruptQueuedIds = [];
    context.turnSawAbortedAssistant = true;
    context.turnResultVerdict = {
      type: "interrupted",
      message: "Claude query ended with aborted_streaming",
    };

    runtime.test.settleInterruptedQuery(context);
    assert.equal(context.readyForInput, true);
    assert.equal(context.turnAborted, false);
  });

  it("forces rebuild when an interrupt receipt retains queued input", () => {
    const runtime = makeRuntime();
    const context = runtime.test.hostContext;
    context.persistent = true;
    context.turnAborted = true;
    context.turnInterruptReceiptReceived = true;
    context.turnInterruptQueuedIds = ["queued-follow-up"];
    runtime.test.setHostSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 });

    runtime.test.settleInterruptedQuery(context);
    assert.equal(context.readyForInput, false);
    assert.match(
      runtime.test.getHostSession().rebuildReason ?? "",
      /^force-close:.*session will rebuild/,
    );
  });
});
