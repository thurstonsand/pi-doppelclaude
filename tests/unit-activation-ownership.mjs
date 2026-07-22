/**
 * Activation-level proof of the process-scoped owner: two activations in one
 * process share one runtime/stream closure, only the creating activation wires
 * runtime-mutating lifecycle handlers, and its shutdown releases the owner so
 * the next activation creates a fresh owner.
 * The live nested-ModelRuntime integration test exercises the corresponding
 * provider call path; this test isolates activation and teardown semantics.
 */
import { describe, it, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the bridge global config (so a developer's real askClaude config cannot
// make loadConfig throw) and seed a valid claude-code prompt mode that needs no
// documentation replacements.
const agentDir = mkdtempSync(join(tmpdir(), "activation-ownership-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "claude-bridge.json"), '{"provider":{"systemPromptMode":"claude-code"}}\n');

const OWNER_KEY = Symbol.for("claude-bridge:owner");
const { default: activate } = await import("../src/index.js");

const MUTATING_EVENTS = ["session_start", "session_shutdown", "model_select", "session_compact", "session_tree"];

function fakePi() {
	const handlers = new Map();
	const providers = [];
	const pi = {
		registerProvider(id, config) { providers.push({ id, config }); },
		on(event, handler) { handlers.set(event, handler); },
	};
	return { pi, handlers, providers };
}

afterEach(() => {
	// Drop any owner left standing so each test starts a fresh process generation.
	globalThis[OWNER_KEY] = undefined;
});

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("extension activation ownership", () => {
	it("shares one runtime/stream across activations and gates lifecycle to its owner", () => {
		const root = fakePi();
		activate(root.pi);
		const borrower = fakePi();
		activate(borrower.pi);

		// Both register, by reference, the same stream closure and models.
		assert.equal(root.providers.length, 1);
		assert.equal(borrower.providers.length, 1);
		assert.strictEqual(borrower.providers[0].config.streamSimple, root.providers[0].config.streamSimple);
		assert.strictEqual(borrower.providers[0].config.models, root.providers[0].config.models);

		// The creating activation wires runtime lifecycle + compaction; the borrower wires only compaction.
		for (const event of MUTATING_EVENTS) assert.ok(root.handlers.has(event), `root missing ${event}`);
		assert.ok(root.handlers.has("session_before_compact"));
		assert.ok(borrower.handlers.has("session_before_compact"), "borrower must still run compaction");
		for (const event of MUTATING_EVENTS) assert.ok(!borrower.handlers.has(event), `borrower must not wire ${event}`);
	});

	it("owner shutdown releases the runtime so the next activation owns a fresh generation", async () => {
		const first = fakePi();
		activate(first.pi);
		const firstStream = first.providers[0].config.streamSimple;

		// A borrower cannot release the owner (it has no shutdown handler at all).
		const borrower = fakePi();
		activate(borrower.pi);
		assert.equal(borrower.handlers.has("session_shutdown"), false);

		// Root shutdown clears the shared runtime and releases the owner.
		await first.handlers.get("session_shutdown")();
		assert.equal(globalThis[OWNER_KEY], undefined);

		// Next activation builds a fresh runtime with a distinct stream closure.
		const next = fakePi();
		activate(next.pi);
		assert.notStrictEqual(next.providers[0].config.streamSimple, firstStream);
	});
});
