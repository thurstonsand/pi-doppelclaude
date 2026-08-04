#!/usr/bin/env node
import assert from "node:assert/strict";
import type { AssistantMessage, AssistantMessageEvent, Context } from "@earendil-works/pi-ai";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { BridgeSessionStore, type SessionStoreWriter } from "../src/session-store.js";
import { bridgeModel } from "./lib/models.js";

class BlockingMirrorStore extends BridgeSessionStore {
  appendCount = 0;
  private blockFirst = true;
  private releaseFirst!: () => void;
  private markFirstStarted!: () => void;
  readonly firstAppendStarted = new Promise<void>((resolve) => {
    this.markFirstStarted = resolve;
  });
  private readonly firstAppendReleased = new Promise<void>((resolve) => {
    this.releaseFirst = resolve;
  });

  release(): void {
    this.releaseFirst();
  }

  override createWriter(label: string): SessionStoreWriter {
    const writer = super.createWriter(label);
    return {
      ...writer,
      append: async (key, entries) => {
        if (this.blockFirst) {
          this.blockFirst = false;
          this.markFirstStarted();
          await this.firstAppendReleased;
        }
        await writer.append(key, entries);
        this.appendCount++;
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
const store = new BlockingMirrorStore();
const runtime = createBridgeRuntime({
  providerSettings: { systemPromptMode: "claude-code" },
  sessionStore: store,
});
const context: Context = {
  systemPrompt: "You are concise.",
  messages: [{ role: "user", content: "Reply only BARRIER_OK.", timestamp: Date.now() }],
};

try {
  let terminal = false;
  const completion = terminalMessage(runtime.stream(model, context)).then((message) => {
    terminal = true;
    return message;
  });
  await store.firstAppendStarted;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    terminal,
    false,
    "provider emitted its terminal result before SessionStore.append completed",
  );

  store.release();
  const message = await completion;
  assert.equal(message.stopReason, "stop");
  assert.match(
    message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    /BARRIER_OK/,
  );
  const appendsAtResult = store.appendCount;
  await runtime.closePersistent("barrier integration");
  assert.ok(
    store.appendCount > appendsAtResult,
    "natural EOF did not deliver its final mirror append",
  );
  console.log("PASS: result waited for append and natural EOF delivered the final mirror batch");
} finally {
  await runtime.clear("integration complete");
}
