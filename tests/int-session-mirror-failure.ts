#!/usr/bin/env node
import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { BridgeSessionStore, type SessionStoreWriter } from "../src/session-store.js";
import { bridgeModel } from "./lib/models.js";

class FailFirstMirrorBatchStore extends BridgeSessionStore {
  private failuresRemaining = 3;

  override createWriter(label: string): SessionStoreWriter {
    const writer = super.createWriter(label);
    return {
      ...writer,
      append: async (key, entries) => {
        if (this.failuresRemaining > 0) {
          this.failuresRemaining--;
          throw new Error("deliberate mirror failure");
        }
        await writer.append(key, entries);
      },
    };
  }
}

async function terminalMessage(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessage> {
  for await (const event of stream) {
    if (event.type === "done") return event.message;
    if (event.type === "error") return event.error;
  }
  throw new Error("provider stream ended without a terminal event");
}

const model = bridgeModel("claude-haiku-4-5");
const sessionStore = new FailFirstMirrorBatchStore();
const runtime = createBridgeRuntime({
  providerSettings: { systemPromptMode: "claude-code" },
  sessionStore,
});
const firstUser = { role: "user", content: "Reply only FIRST.", timestamp: Date.now() } as const;

try {
  const firstContext: Context = { systemPrompt: "You are concise.", messages: [firstUser] };
  const failed = await terminalMessage(runtime.stream(model, firstContext));
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage ?? "", /transcript mirror failed.*deliberate mirror failure/i);
  const invalidated = runtime.test.getHostSession();
  assert.equal(invalidated?.needsRebuild, true);
  assert.equal(
    sessionStore.load(invalidated.sessionId),
    null,
    "partial mirrored transcript survived invalidation",
  );

  const secondUser = {
    role: "user",
    content: "Reply only MIRROR_RECOVERED.",
    timestamp: Date.now() + 1,
  } as const;
  const secondContext: Context = {
    systemPrompt: "You are concise.",
    messages: [firstUser, failed, secondUser],
  };
  const recovered = await terminalMessage(runtime.stream(model, secondContext));
  assert.equal(recovered.stopReason, "stop");
  assert.match(
    recovered.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    /MIRROR_RECOVERED/,
  );
  assert.ok(
    sessionStore.load(runtime.test.getHostSession().sessionId)?.length,
    "rebuilt transcript was not mirrored",
  );
  console.log(
    "PASS: mirror failure invalidated partial state and rebuilt from complete Pi history",
  );
} finally {
  await runtime.clear("integration complete");
}
