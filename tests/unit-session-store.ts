import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  query,
  type SDKUserMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { SESSION_STORE_LOAD_TIMEOUT_MS } from "../src/bridge-runtime.js";
import { PushQueue } from "../src/query-state.js";
import { BridgeSessionStore, MalformedSessionTranscriptError } from "../src/session-store.js";

const key = (sessionId: string, subpath?: string) => ({
  projectKey: "ignored-project-scope",
  sessionId,
  ...(subpath ? { subpath } : {}),
});

describe("BridgeSessionStore", () => {
  it("round-trips cloned transcript entries", async () => {
    const store = new BridgeSessionStore();
    const writer = store.createWriter("test");
    const entries = [{ type: "user", uuid: "u1", message: { content: "hello" } }];
    await writer.append(key("s1"), entries);
    entries[0].message.content = "mutated outside";

    // SessionStoreEntry keeps its payload under an open index signature; view
    // the round-tripped record as the message shape the store cloned.
    const loaded = await writer.load(key("s1"));
    const loadedMessage = loaded[0].message as { content: string };
    assert.equal(loadedMessage.content, "hello");
    loadedMessage.content = "mutated result";
    assert.equal(
      ((await writer.load(key("s1")))[0].message as { content: string }).content,
      "hello",
    );
  });

  it("upserts UUID-bearing mirror retries without duplicating records", async () => {
    const store = new BridgeSessionStore();
    const writer = store.createWriter("test");
    await writer.append(key("s1"), [{ type: "assistant", uuid: "a1", value: "first" }]);
    await writer.append(key("s1"), [{ type: "assistant", uuid: "a1", value: "retry" }]);

    assert.deepEqual(await writer.load(key("s1")), [
      { type: "assistant", uuid: "a1", value: "retry" },
    ]);
  });

  it("preserves entries without UUIDs", async () => {
    const store = new BridgeSessionStore();
    const writer = store.createWriter("test");
    await writer.append(key("s1"), [
      { type: "mode", value: "a" },
      { type: "mode", value: "a" },
    ]);
    assert.equal((await writer.load(key("s1"))).length, 2);
  });

  it("atomically replaces a transcript and fences the old writer", async () => {
    const store = new BridgeSessionStore();
    const oldWriter = store.createWriter("old");
    await oldWriter.append(key("s1"), [{ type: "user", uuid: "old" }]);

    store.replace("s1", [{ type: "user", uuid: "rebuilt" }]);
    await oldWriter.append(key("s1"), [{ type: "assistant", uuid: "late" }]);

    const newWriter = store.createWriter("new");
    assert.deepEqual(await newWriter.load(key("s1")), [{ type: "user", uuid: "rebuilt" }]);
    await newWriter.append(key("s1"), [{ type: "assistant", uuid: "current" }]);
    assert.deepEqual(
      (await newWriter.load(key("s1"))).map((entry) => entry.uuid),
      ["rebuilt", "current"],
    );
  });

  it("fences appends after a writer closes", async () => {
    const store = new BridgeSessionStore();
    const writer = store.createWriter("closed");
    await writer.append(key("s1"), [{ type: "user", uuid: "before" }]);
    writer.close();
    await writer.append(key("s1"), [{ type: "assistant", uuid: "after" }]);
    assert.deepEqual(
      store.load("s1").map((entry) => entry.uuid),
      ["before"],
    );
  });

  it("invalidates a forced writer revision before replacement", async () => {
    const store = new BridgeSessionStore();
    const oldWriter = store.createWriter("forced");
    await oldWriter.append(key("s1"), [{ type: "user", uuid: "before" }]);
    oldWriter.invalidate();
    await oldWriter.append(key("s1"), [{ type: "assistant", uuid: "late" }]);

    const nextWriter = store.createWriter("replacement");
    await nextWriter.append(key("s1"), [{ type: "assistant", uuid: "current" }]);
    assert.deepEqual(
      store.load("s1").map((entry) => entry.uuid),
      ["before", "current"],
    );
  });

  it("rejects malformed transcript entries at the adapter edge", async () => {
    const store = new BridgeSessionStore();
    const writer = store.createWriter("malformed");
    await assert.rejects(
      () => writer.append(key("s1"), [{ uuid: "missing-type" } as SessionStoreEntry]),
      (error) =>
        error instanceof MalformedSessionTranscriptError &&
        /Malformed SessionStore transcript entry/.test(error.message),
    );
  });

  it("configures a finite load timeout and the SDK rejects a stalled load", async () => {
    assert.ok(Number.isFinite(SESSION_STORE_LOAD_TIMEOUT_MS));
    assert.ok(SESSION_STORE_LOAD_TIMEOUT_MS > 0);
    const stalledStore: SessionStore = {
      append: async () => {},
      load: async () => new Promise<SessionStoreEntry[] | null>(() => {}),
    };
    const prompt = new PushQueue<SDKUserMessage>();
    const sdkQuery = query({
      prompt,
      options: {
        resume: "11111111-1111-4111-8111-111111111111",
        sessionStore: stalledStore,
        loadTimeoutMs: 5,
      },
    });
    await assert.rejects(() => sdkQuery.next(), /SessionStore\.load\(\) timed out after 5ms/);
    sdkQuery.close();
  });

  it("keeps subagent transcripts separate and deletes them with the session", async () => {
    const store = new BridgeSessionStore();
    const writer = store.createWriter("test");
    await writer.append(key("s1"), [{ type: "user", uuid: "main" }]);
    await writer.append(key("s1", "subagents/agent-a"), [{ type: "assistant", uuid: "sub" }]);
    assert.deepEqual(await writer.listSubkeys(key("s1")), ["subagents/agent-a"]);

    store.delete("s1");
    assert.equal(store.load("s1"), null);
    assert.equal(store.load("s1", "subagents/agent-a"), null);
  });
});
