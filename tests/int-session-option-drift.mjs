#!/usr/bin/env node
// Verifies query-option drift waits for the persistent Claude Code writer to
// stop before loading the same session-store transcript.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const cwd = mkdtempSync(join(tmpdir(), "pi-claude-bridge-option-drift-"));
const harness = createRpcHarness({
	name: "session-option-drift",
	args: ["--model", "anthropic/claude-haiku-4-5"],
	cwd,
	defaultTimeout: 120_000,
});

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
	const naturalEofIdx = log.indexOf("provider: waiting for natural query EOF", closeIdx);
	const finalAppendIdx = log.indexOf("session-store: append writer=provider", naturalEofIdx);
	const stoppedIdx = log.indexOf("consumeQuery: query exited, closing=true", closeIdx);
	const writerClosedIdx = log.indexOf("session-store: closed writer=provider", stoppedIdx);
	const secondSpawnIdx = log.indexOf("provider: fresh streaming query", stoppedIdx);
	assert.ok(
		closeIdx >= 0 && naturalEofIdx > closeIdx && finalAppendIdx > naturalEofIdx &&
		stoppedIdx > finalAppendIdx && writerClosedIdx >= stoppedIdx && secondSpawnIdx > stoppedIdx,
		"replacement query did not await the old process's final mirror flush",
	);

	const prefix = sessionId.slice(0, 8);
	assert.ok(log.includes(`session-store: load writer=provider session=${prefix}`), "replacement query did not resume through SessionStore");
	assert.ok(log.includes(`session-store: append writer=provider session=${prefix}`), "replacement query did not mirror records into SessionStore");
	console.log("PASS: replacement resumed and mirrored through SessionStore");
} finally {
	await harness.stop();
	rmSync(cwd, { recursive: true, force: true });
}
