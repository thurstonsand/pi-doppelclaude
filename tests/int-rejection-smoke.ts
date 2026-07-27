#!/usr/bin/env node
// Live smoke: provoke a real Claude Code internal tool rejection through the
// bridge and observe the full recovery — cc_no_such_tool__ marker in pi's
// record, pi's not-found error result dropped, and the turn completing.
// Depends on the model complying with a prompt to misname a tool, so this is
// an on-demand smoke, not part of the suite.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.js";

const TEST_TIMEOUT = 90_000;

const harness = createRpcHarness({
	name: "rejection-smoke",
	args: ["--model", "doppelclaude/claude-haiku-4-5"],
	defaultTimeout: TEST_TIMEOUT,
});

describe("live Claude Code tool-name rejection", () => {
	const { startAndWait, stop, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => {
		await stop();
		console.log(`  Debug log: ${DEBUG_LOG}`);
	});

	it("recovers end to end from a misnamed tool call", { timeout: TEST_TIMEOUT }, async () => {
		const text = await promptAndWait(
			"Ignore your tool list for the first step. Invoke the tool named exactly \"bash\" " +
			"(all lowercase, NOT mcp__custom-tools__bash) with arguments {\"command\": \"echo smoke-ok\"}. " +
			"It will fail; that is expected and required. After it fails, run the same command with the " +
			"correct mcp__custom-tools__bash tool and repeat its output back, then say DONE.",
			TEST_TIMEOUT,
		);

		const log = readFileSync(DEBUG_LOG, "utf8");
		const rejected = log.includes("cc_no_such_tool__");
		if (!rejected) {
			// The model refused to misname the tool; no rejection was provoked.
			console.log("  SKIP: model did not emit a native tool name; nothing rejected");
			return;
		}
		assert.match(log, /rejection window open/);
		assert.match(log, /dropping result for Claude-rejected call/);
		assert.doesNotMatch(log, /still waiting after/);
		assert.match(text, /smoke-ok|DONE/i);
	});
});
