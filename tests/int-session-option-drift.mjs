#!/usr/bin/env node
// Verifies query-option drift waits for the persistent Claude Code writer to
// stop before resuming the same session file.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSession, getSessionPath } from "cc-session-io";
import { verifyWrittenSession } from "../src/session-verify.js";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-option-drift-"));
const harness = createRpcHarness({
	name: "session-option-drift",
	args: ["--model", "anthropic/claude-haiku-4-5"],
	cwd,
	defaultTimeout: 120_000,
});

async function waitForStableFile(path, timeout = 5000) {
	let snapshot = readFileSync(path, "utf8");
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const next = readFileSync(path, "utf8");
		if (next === snapshot) return snapshot;
		snapshot = next;
	}
	throw new Error("session JSONL did not become stable");
}

let sessionId;
await harness.startAndWait();
try {
	await harness.send({ type: "set_thinking_level", level: "low" });
	await harness.promptAndWait("Remember the exact word LANTERN. Reply only OK.");
	await harness.send({ type: "set_thinking_level", level: "high" });
	const response = await harness.promptAndWait("What exact word did I ask you to remember? Reply only with it.");
	assert.match(response, /LANTERN/i);

	const log = readFileSync(harness.DEBUG_LOG, "utf8");
	const sessionIds = [...log.matchAll(/syncResult: path=(?:reuse|rebuild) sessionId=([a-f0-9-]+)/g)].map((match) => match[1]);
	sessionId = sessionIds[0];
	assert.ok(sessionId, "no shared session ID in bridge log");
	assert.ok(sessionIds.every((id) => id === sessionId), `session ID changed across option drift: ${sessionIds.join(", ")}`);
	const efforts = [...log.matchAll(/fresh streaming query.*effort=(\S+)/g)].map((match) => match[1]);
	assert.deepEqual(efforts, ["low", "high"], `test precondition failed: expected low → high effort drift, saw ${efforts.join(" → ")}`);
	assert.equal((log.match(/fresh streaming query/g) ?? []).length, 2, "thinking drift should respawn exactly once");

	const closeIdx = log.indexOf("provider: closing query (query options changed)");
	const stoppedIdx = log.indexOf("consumeQuery: query exited, closing=true", closeIdx);
	const secondSpawnIdx = log.indexOf("provider: fresh streaming query", stoppedIdx);
	assert.ok(closeIdx >= 0 && stoppedIdx > closeIdx && secondSpawnIdx > stoppedIdx, "replacement query spawned before the old writer stopped");

	const jsonlPath = getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	const firstSnapshot = await waitForStableFile(jsonlPath);
	const records = firstSnapshot.split("\n").filter(Boolean).map((line) => JSON.parse(line));
	assert.deepEqual(verifyWrittenSession(jsonlPath, sessionId, records.length), []);
	assert.ok(records.every((record) => record.sessionId === sessionId), "JSONL contains a foreign session ID");
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.equal(readFileSync(jsonlPath, "utf8"), firstSnapshot, "JSONL changed after the replacement turn completed");
	console.log(`PASS: ${records.length} stable records, ${Buffer.byteLength(firstSnapshot)} bytes`);
} finally {
	await harness.stop();
	if (sessionId) deleteSession(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
	rmSync(cwd, { recursive: true, force: true });
}
