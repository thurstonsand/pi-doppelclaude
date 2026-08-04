// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { PROVIDER_API, PROVIDER_ID } from "./models.js";
import { MCP_TOOL_PREFIX } from "./skills.js";

/** Marker for a tool name Claude Code declined to dispatch. Nothing in pi can
 *  answer to it, so the call persists in pi's record as a not-found failure. */
export const CC_REJECTED_TOOL_PREFIX = "cc_no_such_tool__";

export function isCcRejectedToolName(name: string): boolean {
  return name.startsWith(CC_REJECTED_TOOL_PREFIX);
}

export function mapSdkToolNameToPi(name: string, customToolNameToPi?: Map<string, string>): string {
  const custom = customToolNameToPi?.get(name) ?? customToolNameToPi?.get(name.toLowerCase());
  if (custom) return custom;
  return `${CC_REJECTED_TOOL_PREFIX}${name}`;
}

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);
  if (existing) return existing;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  cache.set(id, clean);
  return clean;
}

/** A pi tool name as the name a rebuilt transcript has to call it by.
 *
 *  Every tool Claude can call is a pi tool served over MCP as
 *  `mcp__custom-tools__<pi name>` (resolveMcpTools); the map is consulted first
 *  only because it carries the served tool's exact casing. A name it lacks is a
 *  tool pi ran that we do not serve now — an extension since disabled — and it
 *  keeps the MCP namespace too: naming it after a Claude Code builtin would tell
 *  the model a builtin it cannot call is available and was already used. */
export function mapPiToolNameToSdk(
  name: string,
  customToolNameToSdk?: Map<string, string>,
): string {
  if (!name) return "";
  if (isCcRejectedToolName(name)) return name.slice(CC_REJECTED_TOOL_PREFIX.length);
  // Pi history holds pi tool names. Our own SDK prefix can only reach here by
  // feeding already-converted names back through the conversion, and prefixing
  // twice invents a tool nobody serves.
  if (name.toLowerCase().startsWith(MCP_TOOL_PREFIX)) {
    throw new Error(
      `mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`,
    );
  }
  const mapped = customToolNameToSdk?.get(name) ?? customToolNameToSdk?.get(name.toLowerCase());
  return mapped ?? `${MCP_TOOL_PREFIX}${name}`;
}

// Tool results are flattened to text, which is how Claude Code stores most of
// them. Images are the exception: they have no text form, so a result carrying
// one keeps the block-array shape instead (also what CC writes for screenshots).
function toolResultContent(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | ContentBlock[] {
  if (typeof content === "string" || !Array.isArray(content))
    return messageContentToText(content) || "";
  if (!content.some((block) => block.type === "image" && block.data && block.mimeType))
    return messageContentToText(content) || "";
  const blocks: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      });
    } else if (block.type !== "text" && block.type !== "image") {
      // Same marker messageContentToText leaves for unrecognized blocks, so the
      // text and image paths describe an extension's output the same way.
      blocks.push({ type: "text", text: `[${block.type}]` });
    }
  }
  return blocks;
}

export function messageContentToText(
  content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  let hasText = false;
  for (const block of content) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
      hasText = true;
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${block.type}]`);
    }
  }
  return hasText ? parts.join("\n") : "";
}

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
  messages: PiMessage[],
  customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
  const anthropicMessages: SessionMessage[] = [];
  const sanitizedIds = new Map<string, string>();
  // The user message collecting this assistant turn's tool results, if one has
  // been emitted yet, and the index of the assistant message it belongs to. Both
  // are cleared at every assistant message — see the toolResult branch.
  let turnResults: { role: "user"; content: ContentBlock[] } | null = null;
  let turnAssistantIdx: number | null = null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
      } else if (Array.isArray(msg.content)) {
        const parts: ContentBlock[] = [];
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
          else if (block.type === "image" && block.data && block.mimeType) {
            parts.push({
              type: "image",
              source: { type: "base64", media_type: block.mimeType, data: block.data },
            });
          }
        }
        anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
      } else {
        anthropicMessages.push({ role: "user", content: "[empty]" });
      }
    } else if (msg.role === "assistant") {
      turnResults = null;
      turnAssistantIdx = anthropicMessages.length;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const blocks: ContentBlock[] = [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          const sig = block.thinkingSignature;
          const isAnthropicProvider =
            msg.provider === PROVIDER_ID ||
            msg.api === PROVIDER_API ||
            msg.api === "anthropic-messages";
          if (isAnthropicProvider && sig) {
            blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
          }
        } else if (block.type === "toolCall") {
          const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id, sanitizedIds),
            name: toolName,
            input: block.arguments ?? {},
          });
        }
      }
      if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
      anthropicMessages.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      // Pi records one message per tool result, but repairToolPairing only pairs
      // results that share the user message directly after their assistant
      // message. Split across messages, the second and later results of a
      // parallel turn match no pending tool_use id and rebuild as synthetic
      // "[no tool result recorded]" stubs. So the turn's results collect into
      // one user message spliced directly after its assistant message.
      //
      // Collecting into the turn's *first* result message also handles a steer
      // landing mid-execution, which pi records between the results; splicing
      // rather than appending keeps a steer that arrived before the first
      // result from taking the pending ids and stranding every real result
      // behind it. Claude Code normalizes a mid-turn steer to this same order
      // (reorderAttachmentsForAPI), so the reorder matches what CC would show.
      const resultBlock: ContentBlock = {
        type: "tool_result",
        tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds),
        content: toolResultContent(msg.content),
        is_error: msg.isError,
      };
      if (turnResults) {
        turnResults.content.push(resultBlock);
      } else {
        turnResults = { role: "user", content: [resultBlock] };
        // A result with no assistant message before it is malformed history;
        // appending keeps it in order for repairToolPairing to discard.
        anthropicMessages.splice(
          turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1,
          0,
          turnResults,
        );
      }
    }
  }

  return { anthropicMessages, sanitizedIds };
}
