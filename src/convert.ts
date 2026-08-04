// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";
import { PROVIDER_API, PROVIDER_ID } from "./models.js";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
};

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

export function mapPiToolNameToSdk(
  name: string,
  customToolNameToSdk?: Map<string, string>,
): string {
  if (!name) return "";
  if (isCcRejectedToolName(name)) return name.slice(CC_REJECTED_TOOL_PREFIX.length);
  const normalized = name.toLowerCase();
  if (customToolNameToSdk) {
    const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
    if (mapped) return mapped;
  }
  if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
  return pascalCase(name);
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
      const text =
        typeof msg.content === "string" ? msg.content : messageContentToText(msg.content);
      anthropicMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds),
            content: text || "",
            is_error: msg.isError,
          },
        ],
      });
    }
  }

  return { anthropicMessages, sanitizedIds };
}
