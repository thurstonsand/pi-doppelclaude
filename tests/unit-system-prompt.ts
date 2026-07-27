import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClaudeSystemPrompt, rewritePiSystemPrompt } from "../src/system-prompt.js";

const PI_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const SYSTEM_PROMPT = `${PI_IDENTITY}

Available tools:
- read

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/README.md
- Additional docs: /opt/pi/docs
- Examples: /opt/pi/examples
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

const REPLACEMENTS = {
	identity: "Custom identity.",
	toolNameNote: "Custom tool note.",
	documentation: {
		heading: "Custom docs:",
		instructions: ["Custom instructions."],
	},
};

describe("rewritePiSystemPrompt", () => {
	it("uses custom documentation prose while preserving discovered paths", () => {
		const rewritten = rewritePiSystemPrompt(SYSTEM_PROMPT, {
			...REPLACEMENTS,
			documentation: {
				heading: "Custom implementation references:",
				instructions: ["Consult them quietly and only when required."],
			},
		});

		assert.match(rewritten, /Custom implementation references:/);
		assert.match(rewritten, /- Main documentation: \/opt\/pi\/README\.md/);
		assert.match(rewritten, /- Additional docs: \/opt\/pi\/docs/);
		assert.match(rewritten, /Consult them quietly and only when required\./);
		assert.doesNotMatch(rewritten, /Assistant implementation docs/);
	});

	it("joins each instruction line under the preserved paths", () => {
		const rewritten = rewritePiSystemPrompt(SYSTEM_PROMPT, {
			...REPLACEMENTS,
			documentation: {
				heading: "Custom docs:",
				instructions: ["- First line.", "- Second line."],
			},
		});

		assert.match(rewritten, /- Examples: \/opt\/pi\/examples\n- First line\.\n- Second line\./);
	});

	it("applies identity and tool-note replacements", () => {
		const rewritten = rewritePiSystemPrompt(SYSTEM_PROMPT, REPLACEMENTS);

		assert.ok(rewritten.startsWith("Custom identity."));
		assert.match(rewritten, /Custom tool note\.\n\nAvailable tools:/);
	});

	it("uses only the rewritten Pi system prompt in pi mode", () => {
		const systemPrompt = buildClaudeSystemPrompt(SYSTEM_PROMPT, "pi", REPLACEMENTS);

		assert(typeof systemPrompt === "string");
		assert.doesNotMatch(systemPrompt, /Pi documentation/);
		assert.match(systemPrompt, /Custom docs:/);
	});

	it("appends the rewritten Pi system prompt to Claude Code's preset", () => {
		const systemPrompt = buildClaudeSystemPrompt(SYSTEM_PROMPT, "append", REPLACEMENTS);

		assert(typeof systemPrompt !== "string");
		assert.equal(systemPrompt.type, "preset");
		assert.equal(systemPrompt.preset, "claude_code");
		assert.doesNotMatch(systemPrompt.append, /Pi documentation/);
		assert.match(systemPrompt.append, /Custom docs:/);
	});

	it("excludes the Pi system prompt entirely in claude-code mode", () => {
		assert.deepEqual(
			buildClaudeSystemPrompt(SYSTEM_PROMPT, "claude-code", undefined),
			{ type: "preset", preset: "claude_code" },
		);
	});
});
