import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadBridgeSettings } from "../src/settings.js";

function withSettingsDirs(fn: (dirs: { agentDir: string; cwd: string; projectDir: string }) => void) {
	const root = mkdtempSync(join(tmpdir(), "claude-bridge-settings-"));
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

function writeSettings(path: string, claudeBridge: Record<string, unknown>, siblings: Record<string, unknown> = {}): void {
	writeFileSync(path, JSON.stringify({ ...siblings, claudeBridge }));
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
			debug: { enabled: false, logPath: join(agentDir, "claude-bridge.log") },
		});
	}));

	it("does not read project Pi settings", () => withSettingsDirs(({ agentDir, cwd, projectDir }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { pathToClaudeCodeExecutable: "/global/claude", systemPromptMode: "claude-code" },
		});
		writeFileSync(join(projectDir, "settings.json"), "{");

		assert.equal(load(cwd, agentDir).provider.pathToClaudeCodeExecutable, "/global/claude");
	}));

	it("requires custom documentation replacements whenever the Pi prompt is included", () => withSettingsDirs(({ agentDir, cwd }) => {
		for (const systemPromptMode of ["pi", "append"]) {
			writeSettings(join(agentDir, "settings.json"), { provider: { systemPromptMode } });
			assert.throws(
				() => load(cwd, agentDir),
				/claudeBridge\.provider\.systemPromptReplacements\.documentation\.heading and \.instructions/,
			);
		}
	}));

	it("normalizes the default prompt mode after validating its replacements", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: {
				systemPromptReplacements: {
					documentation: {
						heading: "Custom documentation",
						instructions: "Use these paths only when necessary.",
					},
				},
			},
		});

		const settings = load(cwd, agentDir);
		assert.equal(settings.provider.systemPromptMode, "append");
		assert.equal(
			settings.provider.systemPromptReplacements!.documentation!.heading,
			"Custom documentation",
		);
	}));

	it("ignores unknown keys inside claudeBridge", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { systemPromptMode: "claude-code", plan: "max", strictMcpConfig: true, settingSources: [] },
			askClaude: { enabled: true },
			debug: { enabled: true, outputPath: "/tmp/debug.log" },
		});

		const settings = load(cwd, agentDir);
		assert.equal(settings.provider.systemPromptMode, "claude-code");
		assert.deepEqual(settings.debug, { enabled: true, logPath: join(agentDir, "claude-bridge.log") });
	}));

	it("applies debug environment overrides after global file settings", () => withSettingsDirs(({ agentDir, cwd }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { systemPromptMode: "claude-code" },
			debug: { enabled: true, logPath: "/settings/debug.log" },
		});

		assert.deepEqual(load(cwd, agentDir, {
			CLAUDE_BRIDGE_DEBUG: "0",
			CLAUDE_BRIDGE_DEBUG_PATH: "/environment/debug.log",
		}).debug, {
			enabled: false,
			logPath: "/environment/debug.log",
		});
		assert.throws(
			() => load(cwd, agentDir, { CLAUDE_BRIDGE_DEBUG: "yes" }),
			/CLAUDE_BRIDGE_DEBUG must be "1" or "0"/,
		);
	}));

	it("ignores global and project claude-bridge.json files", () => withSettingsDirs(({ agentDir, cwd, projectDir }) => {
		writeSettings(join(agentDir, "settings.json"), {
			provider: { systemPromptMode: "claude-code" },
		});
		writeFileSync(join(agentDir, "claude-bridge.json"), "not json");
		writeFileSync(join(projectDir, "claude-bridge.json"), "not json");

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
