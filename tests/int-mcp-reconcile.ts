#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.js";

const harness = createRpcHarness({
	name: "mcp-reconcile",
	args: [
		"--model", "anthropic-agent-sdk/claude-haiku-4-5",
		"-e", `${process.cwd()}/tests/fixtures/tool-set-extension.ts`,
	],
	defaultTimeout: 120_000,
});

await harness.startAndWait();
try {
	await harness.promptAndWait("Reply only FIRST.");
	await harness.send({ type: "prompt", message: "/phase7-tools read" });
	await harness.promptAndWait("Reply only SECOND.");
	await harness.send({ type: "prompt", message: "/phase7-tools none" });
	await harness.promptAndWait("Reply only THIRD.");

	const log = readFileSync(harness.DEBUG_LOG, "utf8");
	assert.equal((log.match(/provider: fresh streaming query/g) ?? []).length, 1, "tool changes rotated the Claude process");
	assert.equal((log.match(/provider: reconciling MCP tools without process replacement/g) ?? []).length, 2, "tool changes were not reconciled twice");
	assert.match(log, /provider: reconciling MCP tools without process replacement \(replace\/remove\)/);
	console.log("PASS: Pi tool additions/removals reconciled without rotating Claude Code");
} finally {
	await harness.stop();
}
