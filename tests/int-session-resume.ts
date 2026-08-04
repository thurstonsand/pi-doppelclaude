#!/usr/bin/env node
// Context continuity test for pi-doppelclaude provider.
// Verifies that switching away from the provider and back correctly
// preserves conversation context (all messages are flattened into
// each query, so "missed" messages are automatically included).
//
// Requires: pi CLI, Claude Code (for Agent SDK subprocess).
// Requires: DOPPELCLAUDE_TESTING_ALT_PROVIDER and DOPPELCLAUDE_TESTING_ALT_MODEL
// naming any authenticated non-bridge model available to pi.

console.log("=== session-resume-test.ts ===");

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.js";

const OTHER_PROVIDER = requireEnv("DOPPELCLAUDE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("DOPPELCLAUDE_TESTING_ALT_MODEL");

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "doppelclaude/claude-haiku-4-5";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;
const WORD_C = `gamma${Math.random().toString(36).slice(2, 6)}`;

const TEST_CWD_PREFIX = join(tmpdir(), "pi-doppelclaude-session-resume-");
const TEST_CWD = mkdtempSync(TEST_CWD_PREFIX);
mkdirSync(join(TEST_CWD, ".pi"));

// Use harness but with custom args - start on non-provider model
const harness = createRpcHarness({
  name: "session-resume",
  args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
  cwd: TEST_CWD,
  defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, addListener, collectText, DEBUG_LOG, RPC_LOG } = harness;

function waitForIdle(timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for idle")), timeout);
    const remove = addListener((msg) => {
      if (msg.type === "agent_end") {
        clearTimeout(timer);
        remove();
        resolve(msg);
      }
    });
  });
}

async function promptAndWait(message: string) {
  const collector = collectText();
  await send({ type: "prompt", message });
  await waitForIdle();
  return collector.stop();
}

// Start pi
await startAndWait();

try {
  // Turn 1: Non-provider prompt — establishes context before our provider is used
  console.log("Turn 1: Non-provider prompt (establish context)...");
  const text1 = await promptAndWait(
    `The first word is '${WORD_A}'. Acknowledge and be very brief.`,
  );
  if (!text1) throw new Error("Turn 1 produced no text");
  console.log(`  Response: ${text1.slice(0, 80)}`);

  // Switch to provider — first provider turn with prior history (Case 2)
  const [bridgeProvider, bridgeModelId] = BRIDGE_MODEL.split("/");
  console.log(`Switching to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });

  // Turn 2: First provider turn — should see WORD_A from prior non-provider history
  console.log("Turn 2: First provider turn with prior history (Case 2)...");
  const text2 = await promptAndWait(
    `The second word is '${WORD_B}'. Also, what was the first word? Reply with both words separated by a comma.`,
  );
  console.log(`  Response: ${text2.slice(0, 80)}`);
  const lower2 = text2.toLowerCase();
  if (!lower2.includes(WORD_A)) throw new Error(`Turn 2 response missing '${WORD_A}': ${text2}`);
  if (!lower2.includes(WORD_B)) throw new Error(`Turn 2 response missing '${WORD_B}': ${text2}`);

  // Switch to other model — creates missed messages
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  // Turn 3: Non-provider prompt — adds context that provider must see on switch-back
  console.log("Turn 3: Non-provider prompt (creates missed messages)...");
  const text3 = await promptAndWait(
    `The third word is '${WORD_C}'. Acknowledge and be very brief.`,
  );
  if (!text3) throw new Error("Turn 3 produced no text");
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // Switch back to provider — context includes all prior turns (Case 4)
  console.log(`Switching back to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });

  // Turn 4: Provider resumes with missed messages (Case 4)
  console.log("Turn 4: Provider resume with missed messages (Case 4)...");
  const text4 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas.",
  );
  console.log(`  Response: ${text4.slice(0, 80)}`);
  const lower4 = text4.toLowerCase();
  if (!lower4.includes(WORD_A)) throw new Error(`Turn 4 response missing '${WORD_A}': ${text4}`);
  if (!lower4.includes(WORD_B)) throw new Error(`Turn 4 response missing '${WORD_B}': ${text4}`);
  if (!lower4.includes(WORD_C)) throw new Error(`Turn 4 response missing '${WORD_C}': ${text4}`);

  // Turn 5: Abort mid-stream — session should be invalidated, next turn should recover
  console.log("Turn 5: Abort mid-stream (session recovery)...");
  await send({
    type: "prompt",
    message: "Write a detailed 500-word essay about the history of timekeeping.",
  });
  // Set up idle listener before abort so we don't miss agent_end
  const idle5 = waitForIdle();
  await new Promise((r) => setTimeout(r, 2000));
  await send({ type: "abort" });
  await idle5;

  // Turn 6: Provider turn after abort — should NOT get "conversation not found"
  console.log("Turn 6: Provider turn after abort (should recover)...");
  const text6 = await promptAndWait(
    "What were all three words from earlier? Reply with just the three words separated by commas.",
  );
  console.log(`  Response: ${text6.slice(0, 80)}`);
  const lower6 = text6.toLowerCase();
  if (!lower6.includes(WORD_A)) throw new Error(`Turn 6 response missing '${WORD_A}': ${text6}`);
  if (!lower6.includes(WORD_B)) throw new Error(`Turn 6 response missing '${WORD_B}': ${text6}`);
  if (!lower6.includes(WORD_C)) throw new Error(`Turn 6 response missing '${WORD_C}': ${text6}`);

  const debugLog = readFileSync(DEBUG_LOG, "utf8");
  const providerSwitchClose = debugLog.indexOf("provider: closing query (provider switch)");
  const switchBackRebuild = debugLog.indexOf("syncResult: path=rebuild", providerSwitchClose);
  const switchBackSpawn = debugLog.indexOf("provider: fresh streaming query", providerSwitchClose);
  if (providerSwitchClose === -1)
    throw new Error("switching away did not close the persistent provider query");
  if (switchBackRebuild < providerSwitchClose || switchBackSpawn < switchBackRebuild) {
    throw new Error(
      "switching back did not rebuild history before spawning a fresh provider query",
    );
  }
  console.log("  provider switch closed the old query and rebuilt before respawn");

  // SessionStore writer revisions fence late post-abort mirror appends, so the
  // session UUID remains stable across normal rebuilds and abort recovery.
  const sessionIds = new Set();
  for (const match of debugLog.matchAll(
    /syncResult: path=(reuse|rebuild) doppel=\S+ sessionId=([a-f0-9-]+)/g,
  )) {
    sessionIds.add(match[2]);
  }
  if (sessionIds.size === 0) throw new Error("no syncResult markers found in debug log");
  if (sessionIds.size !== 1)
    throw new Error(
      `expected 1 stable sessionId across abort recovery, got ${sessionIds.size}: ${[...sessionIds].join(", ")}`,
    );
  if (
    !debugLog.includes("session-store: ignored stale append") &&
    !debugLog.includes("session-store: replace")
  ) {
    throw new Error("no SessionStore rebuild/fencing diagnostics found after abort");
  }
  console.log("  sessionId remained stable across abort recovery");

  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log(`FAIL: ${e.message}\n${e.stack}`);
  console.log(`  RPC log:    ${RPC_LOG}`);
  console.log(`  Debug log:  ${DEBUG_LOG}`);
  console.log(
    `  CC CLI:     .test-output/cc-cli-logs/  (look for *-provider-*.log near the failing turn)`,
  );
  console.log(
    `  Note: logs are overwritten on next test run — copy them now if you need to investigate.`,
  );
} finally {
  await stop();
  if (TEST_CWD.startsWith(TEST_CWD_PREFIX) && TEST_CWD.length > TEST_CWD_PREFIX.length) {
    rmSync(TEST_CWD, { recursive: true, force: true });
  }
}
