import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";

// Pin both HOME and PI_CODING_AGENT_DIR so loadConfig's global path (getAgentDir)
// resolves to <home>/.pi/agent regardless of the developer's ambient PI_CODING_AGENT_DIR.
function withTempHome(fn: (home: string) => void) {
	const oldHome = process.env.HOME;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("loadConfig", () => {
	it("loads project config from Pi's configured project directory", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { pathToClaudeCodeExecutable: "/project/claude", systemPromptMode: "claude-code" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { pathToClaudeCodeExecutable: "/project/claude", systemPromptMode: "claude-code" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { pathToClaudeCodeExecutable: "/global/claude", systemPromptMode: "claude-code" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { pathToClaudeCodeExecutable: "/project/claude" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { pathToClaudeCodeExecutable: "/project/claude", systemPromptMode: "claude-code" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("requires custom documentation replacements whenever the Pi prompt is included", () => withTempHome((home) => {
		const configDir = join(home, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });

		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			for (const systemPromptMode of ["pi", "append"]) {
				writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
					provider: { systemPromptMode },
				}));
				assert.throws(
					() => loadConfig(cwd),
					/systemPromptReplacements\.documentation\.heading and \.instructions/,
				);
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("accepts custom documentation replacements when the Pi prompt is included", () => withTempHome((home) => {
		const configDir = join(home, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
			provider: {
				systemPromptMode: "pi",
				systemPromptReplacements: {
					documentation: {
						heading: "Custom documentation",
						instructions: "Use these paths only when necessary.",
					},
				},
			},
		}));

		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			assert.equal(loadConfig(cwd).provider.systemPromptReplacements.documentation.heading, "Custom documentation");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("rejects removed settings", () => withTempHome((home) => {
		const configDir = join(home, ".pi", "agent");
		mkdirSync(configDir, { recursive: true });

		const removedConfigs: Record<string, unknown>[] = [
			{ provider: { strictMcpConfig: true } },
			{ provider: { settingSources: [] } },
			{ provider: { plan: "max" } },
			{ provider: { longContextExtraUsage: true } },
			{ askClaude: { enabled: true } },
			{ askClaude: { defaultMode: "read" } },
		];
		for (const removedConfig of removedConfigs) {
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify(removedConfig));
			assert.throws(() => loadConfig(process.cwd()), /must not have additional properties/);
		}
	}));
});
