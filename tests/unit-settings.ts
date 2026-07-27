import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadBridgeSettings } from "../src/settings.js";

function withSettingsDirs(fn: (dirs: { agentDir: string; cwd: string; projectDir: string }) => void) {
	const root = mkdtempSync(join(tmpdir(), "doppelclaude-settings-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	const projectDir = join(cwd, CONFIG_DIR_NAME);
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	try {
		return fn({ agentDir, cwd, projectDir });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function writeSettings(path: string, doppelclaude: Record<string, unknown>, siblings: Record<string, unknown> = {}): void {
	writeFileSync(path, JSON.stringify({ ...siblings, doppelclaude }));
}

function load(cwd: string, agentDir: string, env: NodeJS.ProcessEnv = {}) {
	return loadBridgeSettings(cwd, { agentDir, env });
}

describe("loadBridgeSettings", () => {
	it("loads the namespace from global Pi settings without rejecting sibling settings", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { pathToClaudeCodeExecutable: "/global/claude", systemPromptMode: "claude-code" },
		}, { theme: "dark", retry: { maxRetries: 2 } });

		assert.deepEqual(load(cwd, agentDir), {
			provider: { pathToClaudeCodeExecutable: "/global/claude", systemPromptMode: "claude-code" },
			debug: { enabled: false, logPath: join(agentDir, "doppelclaude.log") },
		});
	}));

	it("does not read project Pi settings", () => withSettingsDirs(({ agentDir, cwd, projectDir }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { pathToClaudeCodeExecutable: "/global/claude", systemPromptMode: "claude-code" },
		});
		writeFileSync(join(projectDir, "settings.json"), "{");

		assert.equal(load(cwd, agentDir).provider.pathToClaudeCodeExecutable, "/global/claude");
	}));

	it("requires custom replacements whenever the Pi prompt is included", () => withSettingsDirs(({ agentDir, cwd }) => {
		for (const systemPromptMode of ["pi", "append"]) {
			writeSettings(join(agentDir, "settings.json"), { provider: { systemPromptMode } });
			assert.throws(
				() => load(cwd, agentDir),
				/requires doppelclaude\.provider\.systemPromptReplacements with identity, toolNameNote, and documentation/,
			);
		}
	}));

	it("rejects replacements that omit any required prose", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: {
				systemPromptReplacements: {
					documentation: { heading: "Custom documentation", instructions: ["Only when necessary."] },
				},
			},
		});

		assert.throws(() => load(cwd, agentDir), /must have required properties identity, toolNameNote/);
	}));

	it("rejects blank replacement prose", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: {
				systemPromptReplacements: {
					identity: "   ",
					toolNameNote: "Custom note.",
					documentation: { heading: "Custom documentation", instructions: ["Only when necessary."] },
				},
			},
		});

		assert.throws(() => load(cwd, agentDir), /identity/);
	}));

	it("defaults the prompt mode to pi after validating its replacements", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: {
				systemPromptReplacements: {
					identity: "Custom identity.",
					toolNameNote: "Custom note.",
					documentation: {
						heading: "Custom documentation",
						instructions: ["Use these paths only when necessary."],
					},
				},
			},
		});

		const settings = load(cwd, agentDir);
		assert.equal(settings.provider.systemPromptMode, "pi");
		assert.equal(
			settings.provider.systemPromptReplacements!.documentation.heading,
			"Custom documentation",
		);
	}));

	it("ignores unknown keys inside doppelclaude", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { systemPromptMode: "claude-code", plan: "max", strictMcpConfig: true, settingSources: [] },
			askClaude: { enabled: true },
			debug: { enabled: true, outputPath: "/tmp/debug.log" },
		});

		const settings = load(cwd, agentDir);
		assert.equal(settings.provider.systemPromptMode, "claude-code");
		assert.deepEqual(settings.debug, { enabled: true, logPath: join(agentDir, "doppelclaude.log") });
	}));

	it("applies debug environment overrides after global file settings", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { systemPromptMode: "claude-code" },
			debug: { enabled: true, logPath: "/settings/debug.log" },
		});

		assert.deepEqual(load(cwd, agentDir, {
			DOPPELCLAUDE_DEBUG: "0",
			DOPPELCLAUDE_DEBUG_PATH: "/environment/debug.log",
		}).debug, {
			enabled: false,
			logPath: "/environment/debug.log",
		});
		assert.throws(
			() => load(cwd, agentDir, { DOPPELCLAUDE_DEBUG: "yes" }),
			/DOPPELCLAUDE_DEBUG must be "1" or "0"/,
		);
	}));

	it("ignores global and project doppelclaude.json files", () => withSettingsDirs(({ agentDir, cwd, projectDir }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { systemPromptMode: "claude-code" },
		});
		writeFileSync(join(agentDir, "doppelclaude.json"), "not json");
		writeFileSync(join(projectDir, "doppelclaude.json"), "not json");

		assert.equal(load(cwd, agentDir).provider.systemPromptMode, "claude-code");
	}));

	it("surfaces global Pi settings parse failures instead of silently using defaults", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeFileSync(join(agentDir, "settings.json"), "{");
		assert.throws(
			() => load(cwd, agentDir),
			/failed to load global Pi settings.*settings\.json/,
		);
	}));
});
