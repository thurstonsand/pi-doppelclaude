/**
 * Proves each createBridgeRuntime() owns its query/session/store state in its
 * own closure — two runtimes cannot bleed state into each other.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeRuntime } from "../src/bridge-runtime.js";

function makeRuntime() {
	return createBridgeRuntime({
		providerSettings: {},
		longContextSettings: { plan: "pro", longContextExtraUsage: false },
	});
}

describe("bridge runtime isolation", () => {
	it("owns an independent root query context per runtime", () => {
		const a = makeRuntime();
		const b = makeRuntime();
		assert.notStrictEqual(a.test.rootContext, b.test.rootContext);

		a.test.rootContext.latestCursor = 99;
		a.test.rootContext.pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });

		assert.strictEqual(b.test.rootContext.latestCursor, 0);
		assert.strictEqual(b.test.rootContext.pendingToolCalls.size, 0);
	});

	it("does not bleed shared-session state between runtimes", () => {
		const a = makeRuntime();
		const b = makeRuntime();

		a.test.setSharedSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 7 });
		assert.equal(b.test.getSharedSession(), null);
		assert.equal(a.test.getSharedSession().sessionId, "11111111-1111-4111-8111-111111111111");

		// Resetting one runtime must not touch the other's session.
		b.test.resetSharedSession();
		assert.equal(a.test.getSharedSession().cursor, 7);
	});

	it("keeps transcript stores independent", () => {
		const a = makeRuntime();
		const b = makeRuntime();
		const cwd = mkdtempSync(join(tmpdir(), "bridge-runtime-store-"));
		try {
			const messages = [
				{ role: "user", content: "remember", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "ok" }], api: "anthropic", provider: "anthropic", model: "claude-haiku-4-5", timestamp: 2 },
				{ role: "user", content: "next", timestamp: 3 },
			];
			const result = a.test.syncSharedSession(messages, cwd);
			assert.equal(result.path, "rebuild");
			assert.ok(a.test.getStoredSession(result.sessionId).length > 0);

			// The second runtime has never seen this session.
			assert.equal(b.test.getStoredSession(result.sessionId), null);
			assert.equal(b.test.getSharedSession(), null);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
