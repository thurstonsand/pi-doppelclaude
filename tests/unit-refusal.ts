import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Query,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { CustomEntry, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { Doppel } from "../src/doppel.js";
import {
  REFUSAL_CUSTOM_TYPE,
  type RefusalEntryData,
  refusalEntryData,
  renderRefusalEntry,
} from "../src/refusal.js";

const fakeModel = {
  api: "doppelclaude",
  provider: "doppelclaude",
  id: "claude-fable-5",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<any>;

// The exact shape the CLI puts on the wire, down to the empty `content` on the no-fallback leg.
const FALLBACK: SDKModelRefusalFallbackMessage = {
  type: "system",
  subtype: "model_refusal_fallback",
  trigger: "refusal",
  direction: "retry",
  original_model: "claude-fable-5",
  fallback_model: "claude-opus-4-8-20260401",
  request_id: "req_011CTqZ9vK3mQx7Lp2NfWdYb",
  api_refusal_category: "cyber",
  api_refusal_explanation: "The request asks for a working exploit chain against a named CVE.",
  retracted_message_uuids: ["6e5a1e2c-9c1d-4b0a-9a1e-2f7c6d3b8a11"],
  refused_user_message_uuid: "3d9c8b7a-1e2f-4a5b-8c6d-9e0f1a2b3c4d",
  content:
    "Fable 5's safeguards flagged this message. Switched to Opus 4.8. Send feedback with /feedback or learn more: https://support.claude.com/en/articles/15363606",
  uuid: "f2a71c40-5b3e-4a1d-9f88-77b2c3d4e5f6",
  session_id: "0199e3a1-2c4b-7d8e-9f01-a2b3c4d5e6f7",
};

const NO_FALLBACK: SDKModelRefusalNoFallbackMessage = {
  type: "system",
  subtype: "model_refusal_no_fallback",
  original_model: "claude-fable-5",
  request_id: "req_011CTqZ9vK3mQx7Lp2NfWdYb",
  api_refusal_category: null,
  api_refusal_explanation: null,
  refused_user_message_uuid: null,
  content: "",
  uuid: "a0b1c2d3-e4f5-4607-8899-aabbccddeeff",
  session_id: "0199e3a1-2c4b-7d8e-9f01-a2b3c4d5e6f7",
};

function entryFor(data: RefusalEntryData): CustomEntry<RefusalEntryData> {
  return {
    type: "custom",
    id: "e1",
    timestamp: "2026-07-27T00:00:00.000Z",
    customType: REFUSAL_CUSTOM_TYPE,
    data,
  } as CustomEntry<RefusalEntryData>;
}

// The host hands the renderer its theme, so the test hands it one that paints nothing.
const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as unknown as Theme;

function plainRender(data: RefusalEntryData, expanded: boolean): string {
  const component = renderRefusalEntry(entryFor(data), { expanded }, plainTheme);
  assert.ok(component, "renderer produced no component");
  return component.render(100).join("\n");
}

describe("Claude refusal entries", () => {
  it("keeps the fields Claude hands us and canonicalizes the model ids", () => {
    assert.deepEqual(refusalEntryData(FALLBACK), {
      requestedModel: "claude-fable-5",
      servedModel: "claude-opus-4-8",
      category: "cyber",
      explanation: "The request asks for a working exploit chain against a named CVE.",
      claudeMessage: FALLBACK.content,
      requestId: FALLBACK.request_id,
    });
    assert.deepEqual(refusalEntryData(NO_FALLBACK), {
      requestedModel: "claude-fable-5",
      servedModel: null,
      category: null,
      explanation: null,
      claudeMessage: "",
      requestId: NO_FALLBACK.request_id,
    });
  });

  it("collapses to a headline carrying whatever key the user bound to expand", () => {
    setKeybindings(
      new KeybindingsManager(
        {
          "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
        } as never,
        { "app.tools.expand": "alt+e" } as never,
      ),
    );
    const collapsed = plainRender(refusalEntryData(FALLBACK), false);
    assert.match(collapsed, /claude-fable-5 refused \(cyber\) — rerouted to claude-opus-4-8/u);
    // Formatted for the platform by Pi, so `alt` surfaces as `option` on macOS.
    assert.match(collapsed, /\((alt|option)\+e to expand\)/u);
    assert.doesNotMatch(collapsed, /exploit chain/u);
  });

  it("says so rather than offering a blank key when nothing is bound", () => {
    setKeybindings(new KeybindingsManager({} as never));
    assert.match(plainRender(refusalEntryData(FALLBACK), false), /\(expand key unbound\)/u);
  });

  it("expands to Claude's explanation, its own banner, and the request id", () => {
    const expanded = plainRender(refusalEntryData(FALLBACK), true);
    assert.match(expanded, /exploit chain against a named CVE/u);
    assert.match(expanded, /Send feedback with \/feedback/u);
    assert.match(expanded, /request req_011CTqZ9vK3mQx7Lp2NfWdYb/u);
  });

  it("still says something when Claude refused without rerouting", () => {
    const expanded = plainRender(refusalEntryData(NO_FALLBACK), true);
    assert.match(expanded, /claude-fable-5 refused — no reply was generated/u);
    assert.match(expanded, /request req_011CTqZ9vK3mQx7Lp2NfWdYb/u);
  });

  it("records the refusal as an entry and stands in for the served-model warning", async () => {
    const warnings: string[] = [];
    const entries: { customType: string; data: RefusalEntryData }[] = [];
    const runtime = createBridgeRuntime({ providerSettings: { systemPromptMode: "claude-code" } });
    runtime.setHost({
      ui: { notify: (message: string) => warnings.push(message) } as unknown as ExtensionUIContext,
      appendEntry: (customType, data) => entries.push({ customType, data }),
    });

    const queryCtx = new Doppel("test-doppel", "guest").context;
    queryCtx.persistent = true;
    queryCtx.currentPiStream = createAssistantMessageEventStream();
    queryCtx.beginCommand(fakeModel);

    const sdkQuery = (async function* () {
      yield FALLBACK;
      // The retry streams on the fallback model; message_start inference would announce it again.
      yield {
        type: "stream_event",
        event: { type: "message_start", message: { model: "claude-opus-4-8-20260401", usage: {} } },
      };
      yield { type: "stream_event", event: { type: "message_stop" } };
    })() as unknown as Query;

    await runtime.test.consumeQuery(sdkQuery, new Map(), fakeModel, queryCtx, {
      onResult() {},
      onSessionId() {},
    });

    assert.deepEqual(
      entries.map((entry) => entry.customType),
      [REFUSAL_CUSTOM_TYPE],
    );
    assert.equal(entries[0].data.servedModel, "claude-opus-4-8");
    assert.deepEqual(warnings, []);
    assert.equal(queryCtx.turnOutput?.responseModel, "claude-opus-4-8");

    // A turn that ends after a refusal must not resurrect the warning as a recap.
    runtime.test.emitTerminalError(queryCtx, "aborted", "Operation aborted");
    assert.deepEqual(warnings, []);
  });
});
