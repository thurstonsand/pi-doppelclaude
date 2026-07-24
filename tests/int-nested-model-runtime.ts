#!/usr/bin/env node
// Regression for nested ModelRuntime calls while the parent Agent SDK query is
// waiting on a Pi tool. The fixture deliberately knows nothing about the bridge:
// it propagates every registered provider config by reference into an ordinary
// nested runtime, preserving the provider's owning stream closure.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.js";

const BRIDGE_MODEL = "anthropic-agent-sdk/claude-haiku-4-5";
const TEST_TIMEOUT = 240_000;
const NESTED_AGENT_EXTENSION = resolve("tests/fixtures/nested-agent-extension.ts");
const REENTRANT_MARKER = /provider: fresh streaming query[^\n]*persistent=false/g;
const STUCK_MARKER = /MCP handlers still waiting after delivering 0 results|tool handler\(s\) still waiting|currentPiStream overwritten/;

const harness = createRpcHarness({
	name: "nested-model-runtime",
	args: ["-e", NESTED_AGENT_EXTENSION, "--model", BRIDGE_MODEL],
	defaultTimeout: TEST_TIMEOUT,
});

const { startAndWait, stop, send, waitForEvent, waitForMatch, collectText, DEBUG_LOG, RPC_LOG } = harness;

function debugLog() {
	try { return readFileSync(DEBUG_LOG, "utf8"); } catch { return ""; }
}

function reentrantCount() {
	return [...debugLog().matchAll(REENTRANT_MARKER)].length;
}

async function waitForReentrantCountAbove(count: number, label: string) {
	const deadline = Date.now() + TEST_TIMEOUT;
	while (Date.now() < deadline) {
		const current = reentrantCount();
		if (current > count) return;
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`${label}: timed out waiting for a reentrant nested-runtime query (count stayed ${count})`);
}

async function runNestedPrompt({ background, expectedMarker }: { background: boolean; expectedMarker: string }) {
	const beforeReentrant = reentrantCount();
	const childMarker = background ? "CHILD-BACKGROUND-COMPLETE" : "CHILD-FOREGROUND-COMPLETE";
	const resultTool = background ? "NestedAgentResult" : "NestedAgent";
	const collector = collectText();
	const nestedStart = waitForMatch(
		(message) => message.type === "tool_execution_start" && message.toolName === "NestedAgent",
		`${background ? "background" : "foreground"} NestedAgent tool_execution_start`,
		TEST_TIMEOUT,
	);
	const childComplete = waitForMatch(
		(message) => message.type === "tool_execution_end" && message.toolName === resultTool &&
			JSON.stringify(message.result).includes(childMarker),
		`${resultTool} result containing ${childMarker}`,
		TEST_TIMEOUT,
	);
	const parentComplete = waitForEvent("agent_end", TEST_TIMEOUT);
	const instructions = background
		? `Call NestedAgent once with background=true and prompt "Reply exactly ${childMarker}". Then call NestedAgentResult with the returned task ID. After it returns, use no more tools and reply exactly ${expectedMarker}.`
		: `Call NestedAgent once with background=false and prompt "Reply exactly ${childMarker}". After it returns, use no more tools and reply exactly ${expectedMarker}.`;

	await send({ type: "prompt", message: instructions }, TEST_TIMEOUT);
	await nestedStart;
	await childComplete;
	await parentComplete;
	const text = collector.stop();
	assert.match(text, new RegExp(expectedMarker), `parent did not report nested completion. Text: ${text.slice(0, 500)}`);
	await waitForReentrantCountAbove(beforeReentrant, background ? "background NestedAgent" : "foreground NestedAgent");
}

await startAndWait();

try {
	await runNestedPrompt({ background: false, expectedMarker: "PARENT-SAW-FOREGROUND-NESTED-AGENT" });
	await runNestedPrompt({ background: true, expectedMarker: "PARENT-SAW-BACKGROUND-NESTED-AGENT" });

	const log = debugLog();
	assert.match(log, /mcp handler: NestedAgent \[toolu_/, "debug log never showed the parent NestedAgent MCP handler");
	assert.doesNotMatch(log, STUCK_MARKER, "debug log contains a stuck-handler or stream-overwrite signature");

	console.log("PASS");
} catch (error) {
	process.exitCode = 1;
	console.log(`FAIL: ${error.message}\n${error.stack}`);
	console.log(`  RPC log:    ${RPC_LOG}`);
	console.log(`  Debug log:  ${DEBUG_LOG}`);
	try { console.log(`  Debug tail:\n${readFileSync(DEBUG_LOG, "utf8").slice(-6000)}`); } catch {}
} finally {
	await stop();
}
