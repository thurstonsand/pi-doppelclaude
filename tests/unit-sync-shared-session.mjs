/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath } from "cc-session-io";
import { createBridgeRuntime } from "../src/bridge-runtime.js";

const { test } = createBridgeRuntime({
	providerSettings: {},
	longContextSettings: { plan: "pro", longContextExtraUsage: false },
});

describe("shared session sync planning", () => {
	afterEach(() => {
		test.resetSharedSession();
	});

	it("plans a clean start when no session exists", () => {
		const plan = test.planSharedSessionSync([{ role: "user", content: "hello", timestamp: Date.now() }], null);
		assert.equal(plan.path, "clean-start");
		assert.equal(plan.previousSession, null);
	});

	it("plans reuse for a trailing assistant without mutating the session", () => {
		const session = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 };
		const plan = test.planSharedSessionSync([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		], session);
		assert.equal(plan.path, "reuse");
		assert.equal(plan.advanceCursor, true);
		assert.equal(session.cursor, 1);
	});

	it("plans rebuild for divergent history", () => {
		const session = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 };
		const plan = test.planSharedSessionSync([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "foreign turn", timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "foreign answer" }], timestamp: 3 },
			{ role: "user", content: "next", timestamp: 4 },
		], session);
		assert.equal(plan.path, "rebuild");
	});

	it("rebuilds into the store without writing Claude's project directory", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-store-"));
		try {
			const messages = [
				{ role: "user", content: "remember one", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "one" }], api: "anthropic", provider: "anthropic", model: "claude-haiku-4-5", timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			];
			const first = test.syncSharedSession(messages, cwd);
			assert.equal(first.path, "rebuild");
			assert.ok(first.sessionId);
			assert.equal(test.getStoredSession(first.sessionId).length, 2);
			assert.equal(existsSync(getSessionPath(first.sessionId, cwd)), false);

			test.setSharedSession({ sessionId: first.sessionId, cursor: 0, needsRebuild: true });
			const second = test.syncSharedSession(messages, cwd);
			assert.equal(second.sessionId, first.sessionId);
			assert.equal(test.getStoredSession(first.sessionId).length, 2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not reuse a cached main session for a shorter synthetic compact context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
			};
			test.setSharedSession(mainSession);

			const result = test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			assert.equal(
				result.sessionId,
				null,
				"synthetic compact contexts have no prior messages and must start a fresh Claude Code session instead of resuming the main session",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh synthetic Claude Code session must not replace the cached main session when it completes",
			);
			assert.deepEqual(test.getSharedSession(), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
