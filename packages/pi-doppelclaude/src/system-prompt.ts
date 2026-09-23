import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { getSystemMessageText, type SystemMessage } from "@earendil-works/pi-ai";
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

const PI_DOCS_HEADING = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):`;

// The docs section's paths are discovered from the running install, so they are kept as-is
// while the prose around them is replaced.
const PI_DOCS_PATH_PREFIXES = ["- Main documentation:", "- Additional docs:", "- Examples:"];

/** Pi builds `tools` and `docs` in the same branch that emits its own preamble, so once the
 *  prompt is recognised as pi's, a missing section means this pi version restructured the prompt — never
 *  that the section was optional. Dropping the tool-name note would be silent, and leaving
 *  docs unpatched would leak, so drift fails here instead. */
function requireSection(sections: Record<string, string | null>, name: string): string {
  const section = sections[name];
  if (!section) {
    throw new Error(
      `doppelclaude: pi built its default system prompt without a "${name}" section, so this pi version restructured the prompt the rewrite replaces; update system-prompt.ts to match`,
    );
  }
  return section;
}

function survivingPiWordingError(wording: string): Error {
  return new Error(
    `doppelclaude: pi's system prompt still contains "${wording.slice(0, 60)}…" after the rewrite, so sending it would leak the wording the rewrite exists to replace. Either this session was recorded before pi 0.87, whose stored flat system prompt pi replays ahead of the sections it builds now — start a new session to use that conversation with this pi version — or an extension forced a system prompt built from \`event.systemPrompt\`, which is pi's own prompt already rendered; have it add its wording through \`systemPromptOptions.sections\` or \`appendSystemPrompt\` instead, which the rewrite can reach`,
  );
}

function rewriteDocsSection(
  section: string,
  documentation: SystemPromptReplacements["documentation"],
): string {
  // An extension can replace pi's docs section by name; its own docs carry no pi wording.
  if (!section.includes(PI_DOCS_HEADING)) return section;
  const pathLines = section
    .split("\n")
    .filter((line) => PI_DOCS_PATH_PREFIXES.some((prefix) => line.startsWith(prefix)));
  // Pi writes all three paths unconditionally, so a missing one means it relabelled them and
  // the replacement docs would ship without the paths they are written to introduce.
  if (pathLines.length !== PI_DOCS_PATH_PREFIXES.length) {
    throw new Error(
      `doppelclaude: pi's docs section listed ${pathLines.length} of the ${PI_DOCS_PATH_PREFIXES.length} expected documentation paths, so this pi version relabelled them; update PI_DOCS_PATH_PREFIXES in system-prompt.ts to match`,
    );
  }
  return [
    "<docs>",
    documentation.heading,
    ...pathLines,
    ...documentation.instructions,
    "</docs>",
  ].join("\n");
}

function replacePiSections(
  sections: Record<string, string | null>,
  replacements: SystemPromptReplacements,
): Record<string, string | null> {
  return {
    ...sections,
    preamble: replacements.identity,
    tools: `${replacements.toolNameNote}\n\n${requireSection(sections, "tools")}`,
    docs: rewriteDocsSection(requireSection(sections, "docs"), replacements.documentation),
  };
}

export type ClaudeSystemPrompt =
  | string
  | {
      type: "preset";
      preset: "claude_code";
      append?: string;
    };

/** Replace the wording that identifies pi, rendering the result as prompt text.
 *
 *  Pi builds its prompt as named sections — an untagged `preamble` plus one `<name>…</name>`
 *  section each — and the transcript carries them structurally, so each replacement patches
 *  the section that owns it instead of matching the rendered text. */
export function rewritePiSystemPrompt(
  message: SystemMessage,
  replacements: SystemPromptReplacements,
): string {
  // Pi builds `tools`, `rules`, and `docs` only alongside its own preamble, so a prompt without
  // them — a preamble set in settings, a forced prompt, or a call that never went through pi's
  // agent loop, like streamSimple — has no section of pi's to replace. Recognising pi's prompt
  // by those sections as well as by its preamble text keeps a reworded preamble from slipping
  // past both the rewrite and the wording check below.
  const sections = message.sections;
  const piBuilt =
    !!sections &&
    (sections.preamble === PI_IDENTITY_PROMPT ||
      ("tools" in sections && "rules" in sections && "docs" in sections));
  if (piBuilt && sections.preamble !== PI_IDENTITY_PROMPT) {
    throw new Error(
      `doppelclaude: pi built its default system prompt with a preamble the rewrite does not recognise, so this pi version reworded it; update PI_IDENTITY_PROMPT in system-prompt.ts to match`,
    );
  }
  const rewritten = piBuilt
    ? getSystemMessageText({ ...message, sections: replacePiSections(sections, replacements) })
    : getSystemMessageText(message);

  // Sections are not the only place pi's wording can ride in. `content` carries the whole flat
  // prompt of a session recorded before pi 0.87, and an extension that forces a prompt built
  // from `event.systemPrompt` forces pi's own prompt already rendered — neither is reachable by
  // replacing sections. Leaking pi's wording is the failure this rewrite exists to prevent, so
  // every prompt is checked on the way out rather than trusted for having the expected shape.
  for (const wording of [PI_IDENTITY_PROMPT, PI_DOCS_HEADING]) {
    if (rewritten.includes(wording)) throw survivingPiWordingError(wording);
  }
  return rewritten;
}

export function buildClaudeSystemPrompt(
  piSystemMessage: SystemMessage | undefined,
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

  const rewrittenPiPrompt = piSystemMessage
    ? rewritePiSystemPrompt(piSystemMessage, replacements)
    : "";
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
