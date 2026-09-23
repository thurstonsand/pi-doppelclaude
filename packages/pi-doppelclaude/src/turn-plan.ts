// Everything about a turn that is a pure function of the request: how Claude Code
// would be spawned for it, and how pi's tools are named to it. No runtime state, so
// the runtime can derive it before deciding whether the turn is pushed into a live
// query or spawns a new one — and derive it again, identically, for a replay.

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  Model,
  SimpleStreamOptions,
  SystemMessage,
  Tool,
  ToolChoice,
} from "@earendil-works/pi-ai";
import { makeCliDebugOptions } from "doppelclaude/debug";
import { sdkChildEnv } from "doppelclaude/sdk-child-env";
import { MCP_TOOL_PREFIX } from "doppelclaude/skills";
import { descriptionExceedsCap } from "doppelclaude/tool-description-relocation";
import { claudeCodeModelId, resolveThinkingEffort } from "./models.js";
import type { ProviderSettings } from "./settings.js";
import {
  buildClaudeSystemPrompt,
  settingSourcesFor,
  type ToolDescriptionRelocation,
} from "./system-prompt.js";

export interface TurnTools {
  mcpTools: Tool[];
  originalMcpTools: Tool[];
  relocations: ToolDescriptionRelocation[];
  customToolNameToSdk: Map<string, string>;
  customToolNameToPi: Map<string, string>;
}

/** Pi's tools reach Claude Code only through the MCP bridge — CC's own tools are already off
 *  (`tools: []` below), so a turn with no MCP tools is a turn Claude Code cannot call one on.
 *  That makes this the single place where `toolChoice: "none"` has to be honored: every SDK
 *  request, spawned or reconciled, takes its tool set from here. */
export function resolveMcpTools(
  tools: Tool[],
  toolDescriptionCap: number | false,
  toolChoice: ToolChoice | undefined,
): TurnTools {
  const mcpTools: Tool[] = [];
  const originalMcpTools: Tool[] = [];
  const relocations: ToolDescriptionRelocation[] = [];
  const customToolNameToSdk = new Map<string, string>();
  const customToolNameToPi = new Map<string, string>();

  if (toolChoice === "none")
    return {
      mcpTools,
      originalMcpTools,
      relocations,
      customToolNameToSdk,
      customToolNameToPi,
    };

  for (const tool of tools) {
    const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
    originalMcpTools.push(tool);
    if (descriptionExceedsCap(tool.description, toolDescriptionCap)) {
      mcpTools.push({ ...tool, description: "" });
      relocations.push({
        name: sdkName,
        description: tool.description,
      });
    } else {
      mcpTools.push(tool);
    }
    customToolNameToSdk.set(tool.name, sdkName);
    customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
    customToolNameToPi.set(sdkName, tool.name);
    customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
  }

  return { mcpTools, originalMcpTools, relocations, customToolNameToSdk, customToolNameToPi };
}

/** The tool set a live query was handed. A change means the servers are reconciled,
 *  not that the process is replaced. */
export function mcpSignature(tools: Tool[]): string {
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  );
}

export interface TurnPlan {
  cwd: string;
  cliModel: string;
  /** The spawn arguments a subprocess cannot be talked out of after the fact. A live
   *  query whose signature no longer matches the turn has to be replaced. */
  spawnSignature: string;
  queryOptions: Options;
}

export function planTurn(input: {
  model: Model<Api>;
  piSystemMessage: SystemMessage | undefined;
  options: SimpleStreamOptions | undefined;
  providerSettings: ProviderSettings;
  /** Only the host's own query outlives its turn; its CLI log is the root one. */
  oneShot: boolean;
  relocations: ToolDescriptionRelocation[];
}): TurnPlan {
  const { model, piSystemMessage, options, providerSettings, oneShot, relocations } = input;
  const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
  const systemPromptMode = providerSettings.systemPromptMode;
  const systemPrompt = buildClaudeSystemPrompt(
    piSystemMessage,
    systemPromptMode,
    providerSettings.systemPromptReplacements,
    relocations,
  );
  const settingSources = settingSourcesFor(systemPromptMode);
  const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
  const effort = resolveThinkingEffort(model, options?.reasoning);
  const cliModel = claudeCodeModelId(model);
  const extraArgs: Record<string, string | null> = {};
  if (effort) extraArgs["thinking-display"] = "summarized";
  const spawnSignature = JSON.stringify({
    cwd,
    systemPrompt,
    effort: effort ?? null,
    settingSources: settingSources ?? null,
    claudeExecutable: claudeExecutable ?? null,
  });
  const queryOptions: Options = {
    cwd,
    env: sdkChildEnv({ DISABLE_AUTO_COMPACT: "1" }),
    tools: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    strictMcpConfig: true,
    systemPrompt,
    model: cliModel,
    extraArgs,
    ...(effort ? { effort } : {}),
    ...(settingSources ? { settingSources } : {}),
    ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
    ...makeCliDebugOptions(oneShot ? "provider-child" : "provider"),
  };
  return { cwd, cliModel, spawnSignature, queryOptions };
}
