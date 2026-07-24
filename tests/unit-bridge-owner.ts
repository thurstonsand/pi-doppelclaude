/**
 * Proves the process-scoped bridge owner: two activations in one process share
 * one owner (and one runtime/stream closure), the runtime is built once, a
 * borrower cannot tear down the owner, and owner teardown permits a fresh
 * generation. Complements unit-bridge-runtime.ts, which proves independently
 * constructed runtimes do not bleed state.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { acquireBridgeOwner } from "../src/bridge-owner.js";
import { createBridgeRuntime } from "../src/bridge-runtime.js";

// The Symbol.for() registry is process-global; release any owner left standing
// so each test starts from a clean process generation. Acquisitions here own
// different owner shapes, so track just the release handle they share.
const openRoots: Array<{ release(): void }> = [];
afterEach(() => {
	for (const acquisition of openRoots.splice(0)) acquisition.release();
});

function counter() {
	let builds = 0;
	return { build: () => ({ id: ++builds }), get builds() { return builds; } };
}

function makeRuntime() {
	return createBridgeRuntime({
		providerSettings: {},
		longContextSettings: { plan: "pro", longContextExtraUsage: false },
	});
}

describe("bridge owner (process-scoped)", () => {
	it("shares one owner across acquisitions and builds it once", () => {
		const c = counter();
		const root = acquireBridgeOwner(c.build);
		openRoots.push(root);
		assert.equal(root.ownsLifecycle, true);
		assert.equal(c.builds, 1);

		const borrower = acquireBridgeOwner(c.build);
		assert.equal(borrower.ownsLifecycle, false);
		assert.strictEqual(borrower.owner, root.owner);
		assert.equal(c.builds, 1);
	});

	it("shares the same runtime and stream closure with borrowers", () => {
		const build = () => ({ runtime: makeRuntime() });
		const root = acquireBridgeOwner(build);
		openRoots.push(root);
		const borrower = acquireBridgeOwner(build);

		assert.strictEqual(borrower.owner.runtime, root.owner.runtime);
		assert.strictEqual(borrower.owner.runtime.stream, root.owner.runtime.stream);
	});

	it("borrower teardown cannot clear the shared owner", () => {
		const c = counter();
		const root = acquireBridgeOwner(c.build);
		openRoots.push(root);
		const borrower = acquireBridgeOwner(c.build);
		assert.equal(borrower.ownsLifecycle, false);

		borrower.release(); // no-op

		const third = acquireBridgeOwner(c.build);
		assert.strictEqual(third.owner, root.owner);
		assert.equal(c.builds, 1);
	});

	it("owner teardown permits a fresh generation", () => {
		const c = counter();
		const first = acquireBridgeOwner(c.build);
		assert.equal(first.ownsLifecycle, true);
		assert.equal(c.builds, 1);

		first.release(); // owner teardown

		const next = acquireBridgeOwner(c.build);
		openRoots.push(next);
		assert.equal(next.ownsLifecycle, true);
		assert.equal(c.builds, 2);
		assert.notStrictEqual(next.owner, first.owner);
	});
});
