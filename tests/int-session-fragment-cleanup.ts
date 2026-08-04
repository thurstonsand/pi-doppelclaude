#!/usr/bin/env node
// Verifies a fresh SDK spawn's local fragment survives only while its writer is live.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectDir } from "cc-session-io";
import { createRpcHarness } from "./lib/rpc-harness.js";

const cwd = mkdtempSync(join(tmpdir(), "pi-doppelclaude-fragment-cleanup-"));
const harness = createRpcHarness({
  name: "session-fragment-cleanup",
  args: ["--model", "doppelclaude/claude-haiku-4-5"],
  cwd,
  defaultTimeout: 120_000,
});

let stopped = false;
try {
  await harness.startAndWait();
  await harness.promptAndWait("Reply only CLEANUP_READY.");

  const log = readFileSync(harness.DEBUG_LOG, "utf8");
  const sessionPrefix = log.match(
    /syncResult: path=clean-start[\s\S]*?turn complete, session=([a-f0-9]+)/,
  )?.[1];
  assert.ok(sessionPrefix, "no clean-start session ID prefix in bridge log");
  const projectDir = getProjectDir(cwd);
  const fragmentName = readdirSync(projectDir).find(
    (name) => name.startsWith(sessionPrefix) && name.endsWith(".jsonl"),
  );
  assert.ok(fragmentName, "test precondition failed: first-spawn fragment was not written");
  const sessionPath = join(projectDir, fragmentName);

  await harness.stop();
  stopped = true;
  assert.equal(existsSync(sessionPath), false, "first-spawn fragment survived session shutdown");

  const shutdownLog = readFileSync(harness.DEBUG_LOG, "utf8");
  assert.ok(
    shutdownLog.includes(`provider: deleted first-spawn session fragment ${sessionPrefix}`),
  );
  console.log("PASS: session shutdown deleted the first-spawn fragment");
} finally {
  if (!stopped) await harness.stop();
  rmSync(cwd, { recursive: true, force: true });
}
