import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MCP_TOOL_PREFIX } from "../src/skills.js";
import { buildClaudeSystemPrompt } from "../src/system-prompt.js";
import { mcpSignature, planTurn, resolveMcpTools } from "../src/turn-plan.js";
import { bridgeModel } from "./lib/models.js";

const REPLACEMENTS = {
  identity: "Bridge identity.",
  toolNameNote: "Tool names are bridged.",
  documentation: {
    heading: "Implementation references:",
    instructions: ["Read them when required."],
  },
};

const PI_IDENTITY =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const PI_PROMPT = `${PI_IDENTITY}

Available tools:
- inspect

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:`;

function tool(description: string): Tool {
  return {
    name: "inspect",
    description,
    parameters: Type.Object({ path: Type.String() }),
  };
}

function context(description: string): Context {
  return {
    systemPrompt: PI_PROMPT,
    messages: [],
    tools: [tool(description)],
  };
}

function planned(description: string, cap: number) {
  const turnContext = context(description);
  const tools = resolveMcpTools(turnContext, cap, undefined);
  const plan = planTurn({
    model: bridgeModel("claude-haiku-4-5"),
    context: turnContext,
    options: undefined,
    providerSettings: {
      systemPromptMode: "pi",
      systemPromptReplacements: REPLACEMENTS,
      toolDescriptionCap: cap,
    },
    oneShot: false,
    relocations: tools.relocations,
  });
  return { plan, tools };
}

describe("tool description relocation", () => {
  it("advertises an empty description and renders the full description for an oversized tool", () => {
    const description = "x".repeat(21);
    const { mcpTools, relocations } = resolveMcpTools(context(description), 20, undefined);

    assert.equal(mcpTools[0].description, "");
    assert.equal(mcpTools[0].name, "inspect");
    assert.deepEqual(mcpTools[0].parameters, Type.Object({ path: Type.String() }));
    assert.deepEqual(relocations, [
      {
        name: `${MCP_TOOL_PREFIX}inspect`,
        description,
      },
    ]);

    const prompt = buildClaudeSystemPrompt(PI_PROMPT, "pi", REPLACEMENTS, relocations);
    assert(typeof prompt === "string");
    assert.match(
      prompt,
      /^ Bridge identity\.\n\nTool names are bridged\.\n\nAvailable tools:\n- inspect\n\n<extended_function_descriptions>\n/,
    );
    assert.doesNotMatch(prompt, /elided|Full definitions|"parameters"/);
    assert.match(
      prompt,
      new RegExp(
        `<function_description>{"name":"${MCP_TOOL_PREFIX}inspect","description":"${description}"}</function_description>`,
      ),
    );
    assert.match(
      prompt,
      /<\/extended_function_descriptions>\n\nIn addition to the tools above, you may have access to other custom tools depending on the project\./,
    );
  });

  it("passes tools at or under the cap through byte-identically", () => {
    for (const length of [19, 20]) {
      const turnContext = context("x".repeat(length));
      const original = turnContext.tools?.[0];
      const resolved = resolveMcpTools(turnContext, 20, undefined);
      assert.strictEqual(resolved.mcpTools[0], original);
      assert.strictEqual(resolved.originalMcpTools[0], original);
      assert.deepEqual(resolved.relocations, []);
    }
  });

  it("prepends the block when the custom-tools anchor is absent", () => {
    const { relocations } = resolveMcpTools(context("oversized"), 4, undefined);
    const prompt = buildClaudeSystemPrompt(
      "A future prompt without the custom-tools note.",
      "pi",
      REPLACEMENTS,
      relocations,
    );

    assert(typeof prompt === "string");
    assert.ok(prompt.startsWith(" <extended_function_descriptions>"));
    assert.match(
      prompt,
      /<\/extended_function_descriptions>\n\nA future prompt without the custom-tools note\.$/,
    );
  });

  it("carries relocations in pi, append, and claude-code prompt modes", () => {
    const { relocations } = resolveMcpTools(context("oversized"), 4, undefined);
    const piPrompt = buildClaudeSystemPrompt(PI_PROMPT, "pi", REPLACEMENTS, relocations);
    const appendPrompt = buildClaudeSystemPrompt(PI_PROMPT, "append", REPLACEMENTS, relocations);
    const claudePrompt = buildClaudeSystemPrompt(PI_PROMPT, "claude-code", undefined, relocations);

    assert(typeof piPrompt === "string");
    assert(typeof appendPrompt !== "string");
    assert(typeof appendPrompt.append === "string");
    assert(typeof claudePrompt !== "string");
    assert(typeof claudePrompt.append === "string");
    for (const prompt of [piPrompt, appendPrompt.append]) {
      assert.ok(prompt.startsWith(" Bridge identity."));
      assert.match(
        prompt,
        /Available tools:\n- inspect\n\n<extended_function_descriptions>[\s\S]*<\/extended_function_descriptions>\n\nIn addition to the tools above/,
      );
    }
    assert.ok(claudePrompt.append.startsWith(" <extended_function_descriptions>"));
    for (const prompt of [piPrompt, appendPrompt.append, claudePrompt.append]) {
      assert.match(prompt, /<function_description>/);
      assert.doesNotMatch(prompt, /elided|Full definitions|"parameters"/);
    }
  });

  it("wraps multiple relocated descriptions in one block", () => {
    const prompt = buildClaudeSystemPrompt(PI_PROMPT, "pi", REPLACEMENTS, [
      { name: `${MCP_TOOL_PREFIX}first`, description: "First description." },
      { name: `${MCP_TOOL_PREFIX}second`, description: "Second description." },
    ]);

    assert(typeof prompt === "string");
    assert.equal((prompt.match(/<extended_function_descriptions>/g) ?? []).length, 1);
    assert.equal((prompt.match(/<\/extended_function_descriptions>/g) ?? []).length, 1);
    assert.equal((prompt.match(/<function_description>/g) ?? []).length, 2);
    assert.match(
      prompt,
      /<function_description>{"name":"mcp__custom-tools__first","description":"First description\."}<\/function_description>\n<function_description>{"name":"mcp__custom-tools__second","description":"Second description\."}<\/function_description>/,
    );
  });

  it("moves oversized description changes into the spawn signature", () => {
    const first = planned(`first-${"x".repeat(20)}`, 20);
    const second = planned(`second-${"x".repeat(20)}`, 20);

    assert.notEqual(first.plan.spawnSignature, second.plan.spawnSignature);
    assert.notEqual(
      mcpSignature(first.tools.originalMcpTools),
      mcpSignature(second.tools.originalMcpTools),
    );
  });

  it("keeps short description changes out of the spawn signature", () => {
    const first = planned("first", 20);
    const second = planned("second", 20);

    assert.equal(first.plan.spawnSignature, second.plan.spawnSignature);
    assert.notEqual(
      mcpSignature(first.tools.originalMcpTools),
      mcpSignature(second.tools.originalMcpTools),
    );
  });

  it("disables relocation without changing today's plan output", () => {
    const turnContext = context("x".repeat(30));
    const disabled = resolveMcpTools(turnContext, false, undefined);
    const baseline = planTurn({
      model: bridgeModel("claude-haiku-4-5"),
      context: turnContext,
      options: undefined,
      providerSettings: {
        systemPromptMode: "pi",
        systemPromptReplacements: REPLACEMENTS,
      },
      oneShot: false,
      relocations: [],
    });
    const withDisabledRelocation = planTurn({
      model: bridgeModel("claude-haiku-4-5"),
      context: turnContext,
      options: undefined,
      providerSettings: {
        systemPromptMode: "pi",
        systemPromptReplacements: REPLACEMENTS,
        toolDescriptionCap: false,
      },
      oneShot: false,
      relocations: disabled.relocations,
    });

    assert.strictEqual(disabled.mcpTools[0], turnContext.tools?.[0]);
    assert.deepEqual(disabled.relocations, []);
    assert.deepEqual(withDisabledRelocation, baseline);
  });
});
