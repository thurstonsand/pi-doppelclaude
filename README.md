# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Based initially on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. This fork adds streaming, MCP tool bridging, custom pi tool bridging, session resume/persistence, context sync, thinking support, skills forwarding, and the AskClaude tool.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider

**FYI:** Anthropic [announced and then unannounced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) a change to how you would be billed for tools that use the Agent SDK like this one. As of June 15, 2026 it uses subscription quota just like Claude Code direct does.

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:pi-claude-bridge
```

## Provider

Use `/model` to select `anthropic/claude-fable-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-5`, `anthropic/claude-sonnet-4-6`, or `anthropic/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default. In the default `append` prompt mode, the rewritten Pi system prompt is appended to Claude Code's preset.

**1M Context:** Opus 4.7 and Opus 4.8 get 1M context by default. Opus 4.6 only gets 1M if you're on a Max plan or pay for Extra Usage. Sonnet 4.6 only gets 1M if you pay for Extra Usage. You will need to set `provider.plan` and/or `provider.longContextExtraUsage` for 1M context in Opus 4.6/Sonnet 4.6 as described in [Configuration](#configuration).

## AskClaude Tool

Available when using any non-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "description": "Custom tool description override"
  },
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "systemPromptMode": "pi",
    "systemPromptReplacements": {
      "identity": "You are a coding assistant running through Claude Code.",
      "toolNameNote": "Prefixed tool names correspond to the bare names used by these instructions.",
      "documentation": {
        "heading": "Implementation references:",
        "instructions": "Resolve documentation paths from the locations above and read relevant files completely."
      }
    },
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:

- `enabled` — register the AskClaude tool (default `true`)
- `description` — override the tool description. Default when `allowFullMode: true`: _"Delegate to Claude Code for a second opinion or analysis (code review, architecture questions, debugging theories), or to autonomously handle a task. Defaults to read-only mode — use full mode when the user wants to delegate a task that requires changes. Prefer to handle straightforward tasks yourself."_
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out

`provider`:

- `plan` (default `"pro"`) — set to `"max"` for Max (or Team Premium/Enterprise) to enable Opus 4.6 with 1M context.
- `longContextExtraUsage` — set to `true` to enable 1M models that cost money through Extra Usage. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `systemPromptMode` — `"claude-code"` uses only Claude Code's preset, `"pi"` uses only the rewritten Pi system prompt, and `"append"` appends the rewritten Pi prompt to Claude Code's preset (default `"append"`).
- `systemPromptReplacements` — replacement prose used whenever the Pi prompt is included (`"pi"` or `"append"`). `documentation.heading` and `documentation.instructions` are required and must be nonblank. `identity` and `toolNameNote` are optional overrides. Discovered installation paths are preserved between the custom heading and instructions.
- Claude Code filesystem settings are isolated in `"pi"` mode and use Claude Code defaults in `"claude-code"` and `"append"` modes. Filesystem and cloud MCP servers are always blocked, since pi is the tool-execution layer.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.

### System prompt modes

#### `"claude-code"`

Uses only Claude Code's preset. The Pi prompt, including its AGENTS.md and skills sections, is excluded. No prompt replacements are required.

#### `"pi"`

Uses only the rewritten Pi prompt. AGENTS.md and skills remain included because they are already sections of Pi's complete prompt. Claude Code's preset is excluded.

#### `"append"`

Uses Claude Code's preset with the complete rewritten Pi prompt appended. AGENTS.md and skills arrive as part of that Pi prompt rather than through a separate extraction path. The old `appendSkills` setting was removed because it would either duplicate this block or violate `"claude-code"` mode's promise to exclude Pi's prompt.

### Pi prompt replacement settings

#### `identity`

Replaces this exact opening text:

```text
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.
```

The setting is optional and retains the bridge's existing identity replacement when omitted.

#### `toolNameNote`

Inserted immediately before Pi's `Available tools:` section. The setting is optional and retains the bridge's existing tool-name note when omitted.

#### `documentation.heading`

The bridge matches and replaces this entire Pi documentation block. Installation paths vary by machine; the three path lines are preserved and placed beneath the replacement heading.

```text
Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: <Pi installation>/README.md
- Additional docs: <Pi installation>/docs
- Examples: <Pi installation>/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)
```

`documentation.heading` is required and replaces the first line. `documentation.instructions` replaces every instruction after the three preserved path lines.

#### `documentation.instructions`

Replaces every instruction after those three path lines, through Pi's final `Always read pi .md files...` line. This setting is required and may contain multiple newline-separated instructions.

### Complete prompt layout

```text
{identity}

{toolNameNote}

Available tools:
<Pi tool descriptions>

<Pi agent guidelines>

{documentation.heading}
- Main documentation: <Pi installation>/README.md
- Additional docs: <Pi installation>/docs
- Examples: <Pi installation>/examples (extensions, custom tools, SDK)
{documentation.instructions}

<Global and project AGENTS.md instructions>

<Pi skills block>

<Pi working-directory and runtime context>
```

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers. Overriding `contextWindow` or other fields requires editing `src/models.ts` directly.

## Tests

`npm run test:unit` for the offline unit suite (`tests/unit-*.mjs`).

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `openrouter/z-ai/glm-4.7-flash`).

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. The main `provider` query stays alive across compatible turns; `provider-child` identifies reentrant/subagent queries, while `askclaude` identifies sub-delegations. Useful when a resume fails or CC misbehaves internally — shows the CLI's own view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Maintenance

After a Claude Code release, review `MODE_DISALLOWED_TOOLS` in `src/index.ts` — it gates which CC tools the AskClaude subagent may invoke per mode (`read` / `full` / `none`). Add new agentic tools (PlanMode, Task spawning, etc.) to the appropriate mode lists if they shouldn't be available to subagents.
