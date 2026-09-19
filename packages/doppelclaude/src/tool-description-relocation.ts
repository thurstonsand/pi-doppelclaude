import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { MCP_TOOL_PREFIX } from "./skills.js";

export interface ToolDescriptionRelocation {
  name: string;
  description: string;
}

export function formatRelocatedToolDescriptions(
  relocations: readonly ToolDescriptionRelocation[],
): string | undefined {
  if (relocations.length === 0) return undefined;
  const descriptions = relocations
    .map(
      (relocation) => `<function_description>${JSON.stringify(relocation)}</function_description>`,
    )
    .join("\n");
  return `<extended_function_descriptions>\n${descriptions}\n</extended_function_descriptions>`;
}

export function insertRelocatedToolDescriptions(systemPrompt: string, block: string): string {
  const anchor = "\n\nIn addition to the tools above";
  if (!systemPrompt.includes(anchor)) return `${block}\n\n${systemPrompt}`;
  return systemPrompt.replace(anchor, `\n\n${block}${anchor}`);
}

export function descriptionExceedsCap(description: string, cap: number | false): boolean {
  return cap !== false && description.length > cap;
}

export interface PreparedToolDescriptions {
  tools: Tool[];
  systemPrompt: string;
  relocations: ToolDescriptionRelocation[];
}

/** Prepares native Messages API tools for exposure through the custom-tools MCP server. */
export function prepareToolDescriptions(
  tools: readonly Tool[],
  systemPrompt: string,
  cap: number | false,
): PreparedToolDescriptions {
  const relocations: ToolDescriptionRelocation[] = [];
  const prepared = tools.map((tool) => {
    if (!tool.description || !descriptionExceedsCap(tool.description, cap)) return { ...tool };
    relocations.push({ name: `${MCP_TOOL_PREFIX}${tool.name}`, description: tool.description });
    return { ...tool, description: "" };
  });
  const block = formatRelocatedToolDescriptions(relocations);
  return {
    tools: prepared,
    systemPrompt: block ? insertRelocatedToolDescriptions(systemPrompt, block) : systemPrompt,
    relocations,
  };
}
