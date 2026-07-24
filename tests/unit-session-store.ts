import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BridgeSessionStore } from "../src/session-store.js";

const key = (sessionId: string, subpath?: string) => ({ projectKey: "ignored-project-scope", sessionId, ...(subpath ? { subpath } : {}) });

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
		assert.equal(((await writer.load(key("s1")))[0].message as { content: string }).content, "hello");
	});

	it("upserts UUID-bearing mirror retries without duplicating records", async () => {
		const store = new BridgeSessionStore();
		const writer = store.createWriter("test");
		await writer.append(key("s1"), [{ type: "assistant", uuid: "a1", value: "first" }]);
		await writer.append(key("s1"), [{ type: "assistant", uuid: "a1", value: "retry" }]);

		assert.deepEqual(await writer.load(key("s1")), [{ type: "assistant", uuid: "a1", value: "retry" }]);
	});

	it("preserves entries without UUIDs", async () => {
		const store = new BridgeSessionStore();
		const writer = store.createWriter("test");
		await writer.append(key("s1"), [{ type: "mode", value: "a" }, { type: "mode", value: "a" }]);
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
		assert.deepEqual((await newWriter.load(key("s1"))).map((entry) => entry.uuid), ["rebuilt", "current"]);
	});

	it("fences appends after a writer closes", async () => {
		const store = new BridgeSessionStore();
		const writer = store.createWriter("closed");
		await writer.append(key("s1"), [{ type: "user", uuid: "before" }]);
		writer.close();
		await writer.append(key("s1"), [{ type: "assistant", uuid: "after" }]);
		assert.deepEqual(store.load("s1").map((entry) => entry.uuid), ["before"]);
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
