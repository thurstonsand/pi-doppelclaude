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
  /** Frontend-specific spawn options. The runtime owns the shared spawn policy (child env,
   *  disabled native tools, permissions, streaming) and the session/MCP fields; a settings
   *  overlay or custom spawner could carry an env of its own, so neither is admitted. */
  options?: Omit<
    Options,
    | "cwd"
    | "model"
    | "systemPrompt"
    | "effort"
    | "mcpServers"
    | "env"
    | "tools"
    | "permissionMode"
    | "allowDangerouslySkipPermissions"
    | "includePartialMessages"
    | "strictMcpConfig"
    | "settings"
    | "spawnClaudeCodeProcess"
  >;
  /** Client tool names to MCP-qualified SDK names, and the inverse used on output. */
  toolNameToSdk?: Map<string, string>;
  toolNameToClient?: Map<string, string>;
  explicitReplay?: boolean;
  /** Permit the core's one-shot recovery when an SDK query dies before producing output. */
  retryDeadQuery?: boolean;
}
