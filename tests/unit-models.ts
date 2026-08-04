import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  claudeCodeModelId,
  compareModels,
  isStableClaudeModelId,
  PROVIDER_API,
  PROVIDER_BASE_URL,
  PROVIDER_ID,
  projectCatalogModels,
  resolveThinkingEffort,
} from "../src/models.js";
import { required } from "./lib/expect.js";

const canonicalModels = getBuiltinModels("anthropic");
const project = (...ids: string[]) => projectCatalogModels(canonicalModels, new Set(ids));
const find = <T extends { id: string }>(models: readonly T[], id: string): T =>
  required(
    models.find((model) => model.id === id),
    `model ${id}`,
  );

describe("native model projection", () => {
  // Ordering belongs to compareModels, which the catalog applies once after merging its sources.
  it("orders models newest family version first", () => {
    const models = project(
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-fable-5",
      "claude-opus-4-8",
    );
    assert.deepEqual(
      [...models].sort(compareModels).map((model) => model.id),
      ["claude-fable-5", "claude-opus-4-8", "claude-opus-4-6", "claude-haiku-4-5"],
    );
  });

  it("projects only allowed stable IDs under the bridge provider identity", () => {
    const models = project(
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-fable-5",
      "claude-opus-4-8",
    );
    assert.deepEqual([...models].map((model) => model.id).sort(), [
      "claude-fable-5",
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-opus-4-8",
    ]);
    for (const model of models) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, PROVIDER_API);
      assert.equal(model.baseUrl, PROVIDER_BASE_URL);
    }
  });

  it("preserves every canonical metadata field other than provider identity", () => {
    for (const model of project("claude-fable-5", "claude-sonnet-5", "claude-haiku-4-5")) {
      const canonical = find(canonicalModels, model.id);
      assert.equal(model.name, canonical.name);
      assert.equal(model.reasoning, canonical.reasoning);
      assert.deepEqual(model.thinkingLevelMap, canonical.thinkingLevelMap);
      assert.deepEqual(model.input, canonical.input);
      assert.deepEqual(model.cost, canonical.cost);
      assert.equal(model.contextWindow, canonical.contextWindow);
      assert.equal(model.maxTokens, canonical.maxTokens);
    }
  });

  it("drops allowed IDs that Pi's canonical catalog cannot describe", () => {
    assert.deepEqual(
      project("claude-sonnet-5", "claude-future-9-9").map((model) => model.id),
      ["claude-sonnet-5"],
    );
  });

  it("rejects mutable and dated identifiers as unstable", () => {
    for (const id of ["sonnet", "default", "claude-haiku-4-5-20251001"]) {
      assert.equal(isStableClaudeModelId(id), false, id);
    }
    assert.equal(isStableClaudeModelId("claude-haiku-4-5"), true);
    assert.deepEqual(project("claude-haiku-4-5-20251001"), []);
  });
});

describe("thinking effort", () => {
  const models = project("claude-sonnet-5", "claude-opus-4-6");

  it("uses native per-model mappings before generic effort aliases", () => {
    assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), "xhigh"), "xhigh");
    assert.equal(resolveThinkingEffort(find(models, "claude-opus-4-6"), "xhigh"), "max");
  });

  it("uses Claude Code defaults when reasoning is off or omitted", () => {
    assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), "max"), "max");
    assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), "off"), undefined);
    assert.equal(resolveThinkingEffort(find(models, "claude-sonnet-5"), undefined), undefined);
  });
});

describe("Claude Code model argument", () => {
  const models = project(
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
  );

  it("uses [1m] for long-context models and the bare ID otherwise", () => {
    assert.equal(claudeCodeModelId(find(models, "claude-fable-5")), "claude-fable-5[1m]");
    assert.equal(claudeCodeModelId(find(models, "claude-opus-4-8")), "claude-opus-4-8[1m]");
    assert.equal(claudeCodeModelId(find(models, "claude-sonnet-5")), "claude-sonnet-5[1m]");
    assert.equal(claudeCodeModelId(find(models, "claude-haiku-4-5")), "claude-haiku-4-5");
  });

  it("uses the final modelOverride context window", () => {
    const opus = { ...find(models, "claude-opus-4-8"), contextWindow: 200_000 };
    const haiku = { ...find(models, "claude-haiku-4-5"), contextWindow: 1_000_000 };
    assert.equal(claudeCodeModelId(opus), "claude-opus-4-8");
    assert.equal(claudeCodeModelId(haiku), "claude-haiku-4-5[1m]");
  });

  it("rejects unknown IDs instead of guessing a context window", () => {
    const unknown = { ...find(models, "claude-opus-4-8"), id: "claude-future-9-9" };
    assert.throws(() => claudeCodeModelId(unknown), /Unsupported Doppelclaude model/);
  });
});
