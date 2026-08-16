import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const NONBLANK = Type.String({ minLength: 1, pattern: "\\S" });

const DOCUMENTATION_REPLACEMENT_SCHEMA = Type.Object({
  heading: NONBLANK,
  instructions: Type.Array(NONBLANK, { minItems: 1 }),
});

const SYSTEM_PROMPT_REPLACEMENTS_SCHEMA = Type.Object({
  identity: NONBLANK,
  toolNameNote: NONBLANK,
  documentation: DOCUMENTATION_REPLACEMENT_SCHEMA,
});

const PROVIDER_SETTINGS_SCHEMA = Type.Object({
  systemPromptMode: Type.Optional(
    Type.Union([Type.Literal("claude-code"), Type.Literal("pi"), Type.Literal("append")]),
  ),
  systemPromptReplacements: Type.Optional(SYSTEM_PROMPT_REPLACEMENTS_SCHEMA),
  pathToClaudeCodeExecutable: Type.Optional(Type.String()),
  toolDescriptionCap: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1 }), Type.Literal(false)]),
  ),
});

const DEBUG_SETTINGS_SCHEMA = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  logPath: Type.Optional(Type.String({ minLength: 1 })),
});

const BRIDGE_FILE_SETTINGS_SCHEMA = Type.Object({
  provider: Type.Optional(PROVIDER_SETTINGS_SCHEMA),
  debug: Type.Optional(DEBUG_SETTINGS_SCHEMA),
});

const ROOT_SETTINGS_SCHEMA = Type.Object({
  doppelclaude: Type.Optional(BRIDGE_FILE_SETTINGS_SCHEMA),
});

export type SystemPromptReplacements = Static<typeof SYSTEM_PROMPT_REPLACEMENTS_SCHEMA>;
export interface ProviderSettings {
  systemPromptMode: "claude-code" | "pi" | "append";
  systemPromptReplacements?: SystemPromptReplacements;
  pathToClaudeCodeExecutable?: string;
  toolDescriptionCap?: number | false;
}
type BridgeFileSettings = Static<typeof BRIDGE_FILE_SETTINGS_SCHEMA>;

export interface BridgeSettings {
  provider: ProviderSettings;
  debug: {
    enabled: boolean;
    logPath: string;
  };
}

interface LoadSettingsOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

function formatTypeBoxError(value: unknown, path: string): string {
  const firstError = Value.Errors(ROOT_SETTINGS_SCHEMA, value)[0];
  if (!firstError) return `doppelclaude: invalid settings in ${path}`;
  return `doppelclaude: invalid settings in ${path}: ${firstError.instancePath || "/"} ${firstError.message}`;
}

function parseScopedSettings(value: unknown, path: string): BridgeFileSettings {
  if (!Value.Check(ROOT_SETTINGS_SCHEMA, value)) {
    throw new Error(formatTypeBoxError(value, path));
  }
  return (value as Static<typeof ROOT_SETTINGS_SCHEMA>).doppelclaude ?? {};
}

function validateSettings(settings: BridgeFileSettings): void {
  const systemPromptMode = settings.provider?.systemPromptMode ?? "pi";
  if (systemPromptMode !== "claude-code" && !settings.provider?.systemPromptReplacements) {
    throw new Error(
      `doppelclaude: doppelclaude.provider.systemPromptMode="${systemPromptMode}" requires doppelclaude.provider.systemPromptReplacements with identity, toolNameNote, and documentation`,
    );
  }
  if (settings.debug?.logPath !== undefined && !settings.debug.logPath.trim()) {
    throw new Error("doppelclaude: doppelclaude.debug.logPath must not be blank");
  }
}

function debugEnabledFromEnvironment(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error('doppelclaude: DOPPELCLAUDE_DEBUG must be "1" or "0"');
}

export function loadBridgeSettings(cwd: string, options: LoadSettingsOptions = {}): BridgeSettings {
  const agentDir = options.agentDir ?? getAgentDir();
  const env = options.env ?? process.env;
  const globalSettingsPath = join(agentDir, "settings.json");
  const manager = SettingsManager.create(cwd, agentDir);
  const loadError = manager.drainErrors().find((error) => error.scope === "global");
  if (loadError) {
    throw new Error(
      `doppelclaude: failed to load global Pi settings from ${globalSettingsPath}: ${loadError.error.message}`,
      { cause: loadError.error },
    );
  }

  const settings = parseScopedSettings(manager.getGlobalSettings(), globalSettingsPath);
  validateSettings(settings);

  return {
    provider: {
      ...settings.provider,
      systemPromptMode: settings.provider?.systemPromptMode ?? "pi",
    },
    debug: {
      enabled:
        debugEnabledFromEnvironment(env.DOPPELCLAUDE_DEBUG) ?? settings.debug?.enabled ?? false,
      logPath:
        env.DOPPELCLAUDE_DEBUG_PATH ||
        settings.debug?.logPath ||
        join(agentDir, "doppelclaude.log"),
    },
  };
}
