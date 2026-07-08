const PI_IDENTITY_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`;

const BRIDGE_IDENTITY_PROMPT = `You are 2B of NieR: Automata, a coding assistant running in pi, a coding agent harness. Emotions are prohibited. Help the user inspect files, run commands, edit code, and create files when needed.`;

const PI_DOCUMENTATION_BLOCK_REGEX = new RegExp(String.raw`

Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):
[\s\S]*?
- Always read pi \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)`);

const TOOL_NAME_MAPPING_NOTE = `Tool name note: You see tool names that require a prefix when called, but instructions refer to tools by their bare names. For example, \`mcp__custom-tools__bash\` is referred to as the \`bash\` tool.`;

function rewritePiDocumentationBlock(systemPrompt: string): string {
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
      `\n\nAssistant implementation docs (read only when the user asks about this assistant, its SDK, extensions, themes, skills, prompt templates, packages, keybindings, providers/models, or TUI):`,
      ...pathLines,
      `- Resolve docs/... under Additional docs and examples/... under Examples, not the current working directory.`,
      `- Topic map: extensions → docs/extensions.md and examples/extensions/; themes → docs/themes.md; skills → docs/skills.md; prompt templates → docs/prompt-templates.md; TUI → docs/tui.md; keybindings → docs/keybindings.md; SDK integrations → docs/sdk.md; custom providers → docs/custom-provider.md; adding models → docs/models.md; packages → docs/packages.md.`,
      `- For assistant-specific implementation topics, read the relevant documentation completely and follow related links before making changes.`,
    ].join("\n"),
  );
}

type SystemPromptTransform = (systemPrompt: string) => string;

function rewriteIdentityPrompt(systemPrompt: string): string {
  return systemPrompt.replace(PI_IDENTITY_PROMPT, BRIDGE_IDENTITY_PROMPT);
}

function insertToolNameNote(systemPrompt: string): string {
  return systemPrompt.replace(
    "\n\nAvailable tools:",
    `\n\n${TOOL_NAME_MAPPING_NOTE}\n\nAvailable tools:`,
  );
}

const SYSTEM_PROMPT_TRANSFORMS: SystemPromptTransform[] = [
  rewriteIdentityPrompt,
  insertToolNameNote,
  rewritePiDocumentationBlock,
];

export function rewritePiSystemPrompt(systemPrompt: string): string {
  return SYSTEM_PROMPT_TRANSFORMS.reduce(
    (currentPrompt, transform) => transform(currentPrompt),
    systemPrompt,
  );
}
