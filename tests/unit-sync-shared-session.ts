/**
 * Regression tests for the session reuse decisions a doppel's sync makes.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath } from "cc-session-io";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { planSessionSync } from "../src/doppel.js";

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
		const plan = planSessionSync([{ role: "user", content: "hello", timestamp: Date.now() }], null);
		assert.equal(plan.path, "clean-start");
		assert.equal(plan.previousSession, null);
	});

	it("plans reuse for a trailing assistant without mutating the session", () => {
		const session = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 };
		const plan = planSessionSync([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		] as unknown as PiMessage[], session);
		assert.equal(plan.path, "reuse");
		assert.equal(plan.advanceCursor, true);
		assert.equal(session.cursor, 1);
	});

	it("plans rebuild for divergent history", () => {
		const session = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 };
		const plan = planSessionSync([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "foreign turn", timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "foreign answer" }], timestamp: 3 },
			{ role: "user", content: "next", timestamp: 4 },
		] as unknown as PiMessage[], session);
		assert.equal(plan.path, "rebuild");
	});

	it("rebuilds into the store without writing Claude's project directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-store-"));
		try {
			const messages = [
				{ role: "user", content: "remember one", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "one" }], api: "doppelclaude", provider: "doppelclaude", model: "claude-haiku-4-5", timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			] as unknown as PiMessage[];
			const first = test.syncHostSession(messages, cwd);
			assert.equal(first.path, "rebuild");
			assert.ok(first.sessionId);
			assert.equal(test.getStoredSession(first.sessionId).length, 2);
			assert.equal(existsSync(getSessionPath(first.sessionId, cwd)), false);

			test.setHostSession({ sessionId: first.sessionId, cursor: 0, needsRebuild: true });
			const second = test.syncHostSession(messages, cwd);
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

			const result = test.syncHostSession([
				{ role: "user", content: "first", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "one" }], api: "doppelclaude", provider: "doppelclaude", model: "claude-haiku-4-5", timestamp: 2 },
				{ role: "user", content: "take that back", timestamp: 3 },
			] as unknown as PiMessage[], cwd);

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
