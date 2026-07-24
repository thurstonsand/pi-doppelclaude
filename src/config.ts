// User-facing extension config from Pi's agent directory (claude-bridge.json)
// and the project Pi config directory, with project settings overriding global.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { type Static, Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });

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
	pathToClaudeCodeExecutable: Type.Optional(Type.String()),
});

const CONFIG_SCHEMA = strictObject({
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
	const global = parseConfigFile(join(getAgentDir(), "claude-bridge.json"));
	const project = parseConfigFile(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	const config = mergeConfig(global, project);
	validateConfig(config);
	return config;
}
