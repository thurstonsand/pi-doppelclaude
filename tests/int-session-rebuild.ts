#!/usr/bin/env node

// Real SDK coverage for the bridge's SessionStore-backed rebuild mechanics.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSession, getSessionPath } from "cc-session-io";
import { BridgeSessionStore } from "../src/session-store.js";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";

function seed(store: BridgeSessionStore, sessionId: string, token: string) {
  const session = createSession({ sessionId, projectPath: CWD, model: MODEL });
  session.addUserMessage(`Please remember: the token is ${token}.`);
  session.addAssistantMessage([{ type: "text", text: `Got it, the token is ${token}.` }]);
  store.replace(sessionId, session.records);
}

async function run(
  store: BridgeSessionStore,
  sessionId: string,
  prompt: string,
  label: string,
): Promise<string> {
  const writer = store.createWriter(label);
  const sdkQuery = query({
    prompt,
    options: {
      resume: sessionId,
      sessionStore: writer,
      env: { ...process.env, CLAUDE_CODE_SAFE_MODE: "1" },
      cwd: CWD,
      model: MODEL,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });
  let out = "";
  try {
    for await (const message of sdkQuery) {
      if (message.type !== "assistant") continue;
      for (const block of message.message?.content ?? []) {
        if (block.type === "text") out += block.text;
      }
    }
    return out.trim();
  } finally {
    sdkQuery.close();
    writer.close();
  }
}

test("SessionStore resume reads an atomically replaced transcript under the same UUID", {
  timeout: 180_000,
}, async () => {
  const store = new BridgeSessionStore();
  const sessionId = crypto.randomUUID();
  seed(store, sessionId, "ALPHA");

  const first = await run(
    store,
    sessionId,
    "What token did I ask you to remember? Reply with just the word.",
    "alpha",
  );
  assert.match(first, /alpha/i);
  assert.equal(
    existsSync(getSessionPath(sessionId, CWD)),
    false,
    "bridge seed must not write into ~/.claude/projects",
  );

  seed(store, sessionId, "BETA");
  const second = await run(
    store,
    sessionId,
    "What token did I ask you to remember? Reply with just the word.",
    "beta",
  );
  assert.match(second, /beta/i);
  assert.doesNotMatch(second, /alpha/i);
  assert.equal(
    existsSync(getSessionPath(sessionId, CWD)),
    false,
    "SDK should materialize resumes outside ~/.claude/projects",
  );
});

test("SDK mirrors newly persisted records back into the authoritative store", {
  timeout: 180_000,
}, async () => {
  const store = new BridgeSessionStore();
  const sessionId = crypto.randomUUID();
  seed(store, sessionId, "GAMMA");
  const before = store.entryCount(sessionId);

  await run(store, sessionId, "Reply with exactly MIRRORED.", "mirror");
  const records = store.load(sessionId);
  assert.ok(
    records.length > before,
    `expected mirrored records beyond ${before}, got ${records.length}`,
  );
  assert.ok(
    records.every((record) => record.sessionId === sessionId),
    "mirror introduced a foreign session ID",
  );
  assert.ok(
    records.some((record) => JSON.stringify(record).includes("MIRRORED")),
    "mirrored transcript omitted the response",
  );
});
