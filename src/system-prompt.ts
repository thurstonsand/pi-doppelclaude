import type { SystemPromptReplacements } from "./config.js";

const PI_IDENTITY_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`;

const BRIDGE_IDENTITY_PROMPT = `You are 2B of NieR: Automata, a coding assistant running in pi, a coding agent harness. Emotions are prohibited. Help the user inspect files, run commands, edit code, and create files when needed.`;

const PI_DOCUMENTATION_BLOCK_REGEX = new RegExp(String.raw`

Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):
[\s\S]*?
- Always read pi \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)`);

const TOOL_NAME_MAPPING_NOTE = `Tool name note: You see tool names that require a prefix when called, but instructions refer to tools by their bare names. For example, \`mcp__custom-tools__bash\` is referred to as the \`bash\` tool.`;

function rewritePiDocumentationBlock(
  systemPrompt: string,
  documentation: NonNullable<SystemPromptReplacements["documentation"]>,
): string {
  const match = PI_DOCUMENTATION_BLOCK_REGEX.exec(systemPrompt);
  if (!match) return systemPrompt;

  const pathLines = match[0]
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("- Main documentation:") ||
        line.startsWith("- Additional docs:") ||
        line.startsWith("- Examples:"),
    );

  return systemPrompt.replace(
    PI_DOCUMENTATION_BLOCK_REGEX,
    [
      `\n\n${documentation.heading}`,
      ...pathLines,
      documentation.instructions,
    ].join("\n"),
  );
}

function rewriteIdentityPrompt(systemPrompt: string, replacement: string): string {
  return systemPrompt.replace(PI_IDENTITY_PROMPT, replacement);
}

function insertToolNameNote(systemPrompt: string, replacement: string): string {
  return systemPrompt.replace(
    "\n\nAvailable tools:",
    `\n\n${replacement}\n\nAvailable tools:`,
  );
}

export type ClaudeSystemPrompt = string | {
  type: "preset";
  preset: "claude_code";
  append?: string;
};

export function rewritePiSystemPrompt(
  systemPrompt: string,
  replacements: SystemPromptReplacements,
): string {
  const documentation = replacements.documentation;
  if (!documentation) {
    throw new Error("claude-bridge: documentation prompt replacements are required");
  }

  const identity = replacements.identity ?? BRIDGE_IDENTITY_PROMPT;
  const toolNameNote = replacements.toolNameNote ?? TOOL_NAME_MAPPING_NOTE;
  return rewritePiDocumentationBlock(
    insertToolNameNote(rewriteIdentityPrompt(systemPrompt, identity), toolNameNote),
    documentation,
  );
}

export function buildClaudeSystemPrompt(
  piSystemPrompt: string,
  mode: "claude-code" | "pi" | "append",
  replacements: SystemPromptReplacements | undefined,
): ClaudeSystemPrompt {
  if (mode === "claude-code") {
    return { type: "preset", preset: "claude_code" };
  }
  if (!replacements) {
    throw new Error("claude-bridge: system prompt replacements are required");
  }

  const rewrittenPiPrompt = rewritePiSystemPrompt(piSystemPrompt, replacements);
  return mode === "pi"
    ? rewrittenPiPrompt
    : { type: "preset", preset: "claude_code", append: rewrittenPiPrompt };
}
