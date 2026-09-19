import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages";

/** Input shared by frontends. Tool definitions use bare MCP names; history uses qualified names. */
export interface RuntimeRequest {
  /** Stable frontend conversation identity. Omit only for a deliberately ephemeral request. */
  conversationKey?: string;
  ephemeral?: boolean;
  model: string;
  sdkModel?: string;
  messages: MessageParam[];
  tools?: Tool[];
  systemPrompt?: Options["systemPrompt"];
  effort?: Options["effort"];
  maxTokens?: number;
  signal?: AbortSignal;
  cwd: string;
  /** Frontend-prepared SDK spawn policy; runtime-owned session/MCP fields are added later. */
  options?: Omit<Options, "cwd" | "model" | "systemPrompt" | "effort" | "mcpServers">;
  /** Client tool names to MCP-qualified SDK names, and the inverse used on output. */
  toolNameToSdk?: Map<string, string>;
  toolNameToClient?: Map<string, string>;
  explicitReplay?: boolean;
}
