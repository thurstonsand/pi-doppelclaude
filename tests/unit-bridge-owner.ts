import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { acquireBridgeOwner } from "../src/bridge-owner.js";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { createAnthropicAgentSdkProvider } from "../src/provider.js";

const openRoots: Array<{ release(): void }> = [];
afterEach(() => {
  for (const acquisition of openRoots.splice(0)) acquisition.release();
});

function makeOwner() {
  const runtime = createBridgeRuntime({ providerSettings: { systemPromptMode: "claude-code" } });
  const provider = createAnthropicAgentSdkProvider({
    stream: runtime.stream,
    accountProbe: async () => ({ available: true, supportedModels: [] }),
  });
  return { runtime, provider };
}

function counter() {
  let builds = 0;
  return {
    build: () => {
      builds++;
      return makeOwner();
    },
    get builds() {
      return builds;
    },
  };
}

describe("bridge owner (process-scoped)", () => {
  it("shares the complete Provider/runtime pair and builds it once", () => {
    const c = counter();
    const root = acquireBridgeOwner(c.build);
    openRoots.push(root);
    assert.equal(root.ownsLifecycle, true);
    assert.equal(c.builds, 1);

    const borrower = acquireBridgeOwner(c.build);
    assert.equal(borrower.ownsLifecycle, false);
    assert.strictEqual(borrower.owner, root.owner);
    assert.strictEqual(borrower.owner.provider, root.owner.provider);
    assert.strictEqual(borrower.owner.runtime.stream, root.owner.runtime.stream);
    assert.equal(c.builds, 1);
  });

  it("borrower teardown cannot clear the shared owner", () => {
    const c = counter();
    const root = acquireBridgeOwner(c.build);
    openRoots.push(root);
    const borrower = acquireBridgeOwner(c.build);
    borrower.release();

    const third = acquireBridgeOwner(c.build);
    assert.strictEqual(third.owner, root.owner);
    assert.equal(c.builds, 1);
  });

  it("owner teardown permits a fresh generation", () => {
    const c = counter();
    const first = acquireBridgeOwner(c.build);
    assert.equal(first.ownsLifecycle, true);
    first.release();

    const next = acquireBridgeOwner(c.build);
    openRoots.push(next);
    assert.equal(next.ownsLifecycle, true);
    assert.equal(c.builds, 2);
    assert.notStrictEqual(next.owner.provider, first.owner.provider);
    assert.notStrictEqual(next.owner.runtime.stream, first.owner.runtime.stream);
  });
});
