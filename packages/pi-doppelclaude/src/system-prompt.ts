import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import {
  formatRelocatedToolDescriptions,
  insertRelocatedToolDescriptions,
  type ToolDescriptionRelocation,
} from "doppelclaude/tool-description-relocation";
import type { SystemPromptReplacements } from "./settings.js";

export type { ToolDescriptionRelocation } from "doppelclaude/tool-description-relocation";

// "pi" mode isolates Claude Code's filesystem settings ([] = no setting sources);
// every other mode keeps Claude Code's defaults (undefined).
export function settingSourcesFor(systemPromptMode: string): SettingSource[] | undefined {
  return systemPromptMode === "pi" ? [] : undefined;
}

const PI_IDENTITY_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`;

const PI_DOCUMENTATION_BLOCK_REGEX =
  /\n\nPi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):\n[\s\S]*?\n- Always read pi \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)/;

function rewritePiDocumentationBlock(
  systemPrompt: string,
  documentation: SystemPromptReplacements["documentation"],
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
    [`\n\n${documentation.heading}`, ...pathLines, ...documentation.instructions].join("\n"),
  );
}

function rewriteIdentityPrompt(systemPrompt: string, replacement: string): string {
  return systemPrompt.replace(PI_IDENTITY_PROMPT, replacement);
}

function insertToolNameNote(systemPrompt: string, replacement: string): string {
  return systemPrompt.replace("\n\nAvailable tools:", `\n\n${replacement}\n\nAvailable tools:`);
}

export type ClaudeSystemPrompt =
  | string
  | {
      type: "preset";
      preset: "claude_code";
      append?: string;
    };

// Calls that never went through pi's agent loop — e.g. streamSimple
// — carry a system prompt with none of pi's blocks in it.
export function rewritePiSystemPrompt(
  systemPrompt: string,
  replacements: SystemPromptReplacements,
): string {
  if (!systemPrompt.includes(PI_IDENTITY_PROMPT)) return systemPrompt;

  return rewritePiDocumentationBlock(
    insertToolNameNote(
      rewriteIdentityPrompt(systemPrompt, replacements.identity),
      replacements.toolNameNote,
    ),
    replacements.documentation,
  );
}

export function buildClaudeSystemPrompt(
  piSystemPrompt: string,
  mode: "claude-code" | "pi" | "append",
  replacements: SystemPromptReplacements | undefined,
  relocations: ToolDescriptionRelocation[] = [],
): ClaudeSystemPrompt {
  const relocationBlock = formatRelocatedToolDescriptions(relocations);
  if (mode === "claude-code") {
    return {
      type: "preset",
      preset: "claude_code",
      ...(relocationBlock ? { append: ` ${relocationBlock}` } : {}),
    };
  }
  if (!replacements) {
    throw new Error("doppelclaude: system prompt replacements are required");
  }

  const rewrittenPiPrompt = rewritePiSystemPrompt(piSystemPrompt, replacements);
  const promptWithRelocations = relocationBlock
    ? insertRelocatedToolDescriptions(rewrittenPiPrompt, relocationBlock)
    : rewrittenPiPrompt;
  // Claude Code puts its own identity in a separate system block right before ours and
  // joins nothing between them, so without this the two run together as "…Agent SDK.You are".
  const separatedPiPrompt = ` ${promptWithRelocations}`;
  return mode === "pi"
    ? separatedPiPrompt
    : { type: "preset", preset: "claude_code", append: separatedPiPrompt };
}
