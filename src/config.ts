// User-facing extension config from ~/.pi/agent/claude-bridge.json and the
// project Pi config directory, with project settings overriding global settings.

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type Static, Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

const ASK_CLAUDE_CONFIG_SCHEMA = strictObject({
	enabled: Type.Optional(Type.Boolean()),
	name: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	defaultMode: Type.Optional(Type.Union([
		Type.Literal("full"),
		Type.Literal("read"),
		Type.Literal("none"),
	])),
	defaultIsolated: Type.Optional(Type.Boolean()),
	allowFullMode: Type.Optional(Type.Boolean()),
});

const DOCUMENTATION_REPLACEMENT_SCHEMA = strictObject({
	heading: Type.String({ minLength: 1 }),
	instructions: Type.String({ minLength: 1 }),
});

const SYSTEM_PROMPT_REPLACEMENTS_SCHEMA = strictObject({
	identity: Type.Optional(Type.String()),
	toolNameNote: Type.Optional(Type.String()),
	documentation: Type.Optional(DOCUMENTATION_REPLACEMENT_SCHEMA),
});

const PROVIDER_CONFIG_SCHEMA = strictObject({
	systemPromptMode: Type.Optional(Type.Union([
		Type.Literal("claude-code"),
		Type.Literal("pi"),
		Type.Literal("append"),
	])),
	systemPromptReplacements: Type.Optional(SYSTEM_PROMPT_REPLACEMENTS_SCHEMA),
	settingSources: Type.Optional(Type.Array(Type.Union([
		Type.Literal("user"),
		Type.Literal("project"),
		Type.Literal("local"),
	]))),
	strictMcpConfig: Type.Optional(Type.Boolean()),
	pathToClaudeCodeExecutable: Type.Optional(Type.String()),
	plan: Type.Optional(Type.Union([Type.Literal("pro"), Type.Literal("max")])),
	longContextExtraUsage: Type.Optional(Type.Boolean()),
});

const CONFIG_SCHEMA = strictObject({
	askClaude: Type.Optional(ASK_CLAUDE_CONFIG_SCHEMA),
	provider: Type.Optional(PROVIDER_CONFIG_SCHEMA),
});

export type Config = Static<typeof CONFIG_SCHEMA>;
export type SystemPromptReplacements = Static<typeof SYSTEM_PROMPT_REPLACEMENTS_SCHEMA>;

function formatTypeBoxError(value: unknown, path: string): string {
	const firstError = Value.Errors(CONFIG_SCHEMA, value)[0];
	if (!firstError) return `claude-bridge: invalid config in ${path}`;
	const instancePath = firstError.instancePath || "/";
	const additionalProperties = (firstError.params as { additionalProperties?: string[] }).additionalProperties;
	const invalidPath = additionalProperties?.length
		? `${instancePath === "/" ? "" : instancePath}/${additionalProperties[0]}`
		: instancePath;
	return `claude-bridge: invalid config in ${path}: ${invalidPath} ${firstError.message}`;
}

function parseConfigFile(path: string): Config {
	if (!existsSync(path)) return {};

	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`claude-bridge: failed to parse ${path}: ${error}`);
	}

	if (!Value.Check(CONFIG_SCHEMA, value)) {
		throw new Error(formatTypeBoxError(value, path));
	}
	return value as Config;
}

function mergeConfig(global: Config, project: Config): Config {
	const globalReplacements = global.provider?.systemPromptReplacements;
	const projectReplacements = project.provider?.systemPromptReplacements;
	const systemPromptReplacements = globalReplacements || projectReplacements
		? {
			...globalReplacements,
			...projectReplacements,
			documentation: projectReplacements?.documentation ?? globalReplacements?.documentation,
		}
		: undefined;

	return {
		askClaude: { ...global.askClaude, ...project.askClaude },
		provider: {
			...global.provider,
			...project.provider,
			...(systemPromptReplacements ? { systemPromptReplacements } : {}),
		},
	};
}

function validateConfig(config: Config): void {
	const systemPromptMode = config.provider?.systemPromptMode ?? "append";
	if (systemPromptMode === "claude-code") return;

	const documentation = config.provider?.systemPromptReplacements?.documentation;
	if (!documentation) {
		throw new Error(
			`claude-bridge: provider.systemPromptMode="${systemPromptMode}" requires provider.systemPromptReplacements.documentation.heading and .instructions`,
		);
	}
	if (!documentation.heading.trim() || !documentation.instructions.trim()) {
		throw new Error(
			"claude-bridge: provider.systemPromptReplacements.documentation.heading and .instructions must not be blank",
		);
	}
}

export function loadConfig(cwd: string): Config {
	const global = parseConfigFile(join(homedir(), ".pi", "agent", "claude-bridge.json"));
	const project = parseConfigFile(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	const config = mergeConfig(global, project);
	validateConfig(config);
	return config;
}
