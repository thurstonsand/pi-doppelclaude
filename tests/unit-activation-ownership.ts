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
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Isolate the bridge settings and seed a valid claude-code prompt mode that
// needs no documentation replacements.
const agentDir = mkdtempSync(join(tmpdir(), "activation-ownership-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), '{"claudeBridge":{"provider":{"systemPromptMode":"claude-code"}}}\n');

const OWNER_KEY = Symbol.for("claude-bridge:owner");
// The owner lives on globalThis under a symbol key; view it as a symbol-keyed
// record so reads/clears are typed instead of indexing typeof globalThis.
const ownerRegistry = globalThis as Record<symbol, unknown>;
const { default: activate } = await import("../src/index.js");

const MUTATING_EVENTS = ["session_start", "session_shutdown", "model_select", "session_compact", "session_tree"];

function fakePi() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const providers: Provider[] = [];
	const pi = {
		registerProvider(provider: Provider) { providers.push(provider); },
		on(event: string, handler: (...args: unknown[]) => unknown) { handlers.set(event, handler); },
	} as unknown as ExtensionAPI;
	return { pi, handlers, providers };
}

afterEach(() => {
	// Drop any owner left standing so each test starts a fresh process generation.
	ownerRegistry[OWNER_KEY] = undefined;
});

after(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("extension activation ownership", () => {
	it("registers the provider without any discovery work", () => {
		const root = fakePi();
		activate(root.pi);
		assert.equal(root.providers.length, 1);
	});

	it("shares one runtime/stream across activations and gates lifecycle to its owner", async () => {
		const root = fakePi();
		activate(root.pi);
		const borrower = fakePi();
		activate(borrower.pi);

		// Both register the complete native Provider object by reference.
		assert.equal(root.providers.length, 1);
		assert.equal(borrower.providers.length, 1);
		assert.strictEqual(borrower.providers[0], root.providers[0]);
		assert.strictEqual(borrower.providers[0].streamSimple, root.providers[0].streamSimple);

		// The creating activation wires runtime lifecycle + compaction; the borrower wires only compaction.
		for (const event of MUTATING_EVENTS) assert.ok(root.handlers.has(event), `root missing ${event}`);
		assert.ok(root.handlers.has("session_before_compact"));
		assert.ok(borrower.handlers.has("session_before_compact"), "borrower must still run compaction");
		for (const event of MUTATING_EVENTS) assert.ok(!borrower.handlers.has(event), `borrower must not wire ${event}`);
	});

	it("owner shutdown releases the runtime so the next activation owns a fresh generation", async () => {
		const first = fakePi();
		activate(first.pi);
		const firstProvider = first.providers[0];

		// A borrower cannot release the owner (it has no shutdown handler at all).
		const borrower = fakePi();
		activate(borrower.pi);
		assert.equal(borrower.handlers.has("session_shutdown"), false);

		// Root shutdown clears the shared runtime and releases the owner.
		await first.handlers.get("session_shutdown")();
		assert.equal(ownerRegistry[OWNER_KEY], undefined);

		// Next activation builds a fresh runtime with a distinct stream closure.
		const next = fakePi();
		activate(next.pi);
		assert.notStrictEqual(next.providers[0], firstProvider);
		assert.notStrictEqual(next.providers[0].streamSimple, firstProvider.streamSimple);
	});
});
