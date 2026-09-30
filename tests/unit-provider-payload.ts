import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { applyPayloadHook, type ProviderPayload } from "pi-doppelclaude/provider-payload";

const model = { id: "claude-opus-4-6" } as Model<Api>;

const tool = (name: string) => ({
  name,
  description: name,
  input_schema: { type: "object" as const, properties: {} },
});

const request: RuntimeRequest = {
  model: model.id,
  messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" },
  ],
  tools: [tool("read"), tool("bash")],
  systemPrompt: "system",
  cwd: process.cwd(),
};

const edit = (change: (payload: ProviderPayload) => unknown) => (payload: unknown) =>
  change(payload as ProviderPayload);

describe("applyPayloadHook", () => {
  it("passes the request through without a hook or a replacement", async () => {
    assert.equal(await applyPayloadHook(request, model, undefined), request);
    assert.deepEqual(
      await applyPayloadHook(
        request,
        model,
        edit(() => undefined),
      ),
      { ...request, maxTokens: undefined },
    );
  });

  it("honours in-place edits to the newest message without touching the request", async () => {
    const sent = await applyPayloadHook(
      request,
      model,
      edit((payload) => {
        payload.messages[2] = { role: "user", content: "mutated" };
      }),
    );
    assert.deepEqual(sent.messages.at(-1), { role: "user", content: "mutated" });
    assert.deepEqual(request.messages.at(-1), { role: "user", content: "again" });
  });

  it("takes a replaced newest message and a subset of tools", async () => {
    const sent = await applyPayloadHook(
      request,
      model,
      edit((payload) => ({
        ...payload,
        messages: [...payload.messages.slice(0, -1), { role: "user", content: "rewritten" }],
        tools: [payload.tools[1]],
      })),
    );
    assert.deepEqual(sent.messages.at(-1), { role: "user", content: "rewritten" });
    assert.deepEqual(
      sent.tools?.map((entry) => entry.name),
      ["bash"],
    );
    assert.equal(sent.systemPrompt, "system");
  });

  it("rejects a changed model", async () => {
    await assert.rejects(
      applyPayloadHook(
        request,
        model,
        edit((payload) => ({ ...payload, model: "claude-haiku-4-5" })),
      ),
      /cannot change the model/,
    );
  });

  it("rejects a changed system prompt", async () => {
    await assert.rejects(
      applyPayloadHook(
        request,
        model,
        edit((payload) => ({ ...payload, system: "other" })),
      ),
      /cannot change the system prompt/,
    );
  });

  it("rejects rewritten or extended history", async () => {
    for (const change of [
      (payload: ProviderPayload) => {
        payload.messages[0] = { role: "user", content: "rewritten" };
      },
      (payload: ProviderPayload) => {
        payload.messages.push({ role: "user", content: "extra" });
      },
    ])
      await assert.rejects(
        applyPayloadHook(request, model, edit(change)),
        /can only rewrite the newest message/,
      );
  });

  it("rejects fields the bridge cannot forward", async () => {
    await assert.rejects(
      applyPayloadHook(
        request,
        model,
        edit((payload) => ({ ...payload, thinking: { type: "disabled" } })),
      ),
      /invalid provider payload/,
    );
  });

  it("rejects an undeclared tool", async () => {
    await assert.rejects(
      applyPayloadHook(
        request,
        model,
        edit((payload) => ({ ...payload, tools: [...payload.tools, tool("write")] })),
      ),
      /undeclared tool write/,
    );
  });

  it("rejects a malformed payload", async () => {
    await assert.rejects(
      applyPayloadHook(
        request,
        model,
        edit((payload) => ({ ...payload, messages: [{ role: "system", content: "x" }] })),
      ),
      /invalid provider payload/,
    );
  });
});
