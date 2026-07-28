# CONTEXT.md

## Cast

- **Pi**: The host coding agent harness. Owns the TUI, tool execution, conversation history, and context management.
- **Claude Code** / **CC**: Anthropic's coding agent, spawned as a subprocess. Owns authentication, model access, and subscription quota.
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`, the programmatic interface used to spawn and drive Claude Code `query()` processes.
- **Doppelclaude** / **the bridge**: This extension, published as `pi-doppelclaude`. Presents Claude Code to Pi as a native provider and keeps the two agents' views of the conversation reconciled.

## Provider and runtime

- **Provider**: The native `pi-ai` Provider registered as `doppelclaude`. Pi's canonical model metadata is authoritative for display and behavior; Claude Code executes the requests.
- **Bridge owner**: The process-scoped singleton Provider/runtime pair. The first activation builds and owns it; later activations borrow it, so all provider calls route through one runtime.

## Session sync

- **Sync paths**: `reuse` (Pi's history matches the live session; send only the new tail), `rebuild` (history diverged; synthesize a complete CC transcript and atomically replace the store entry), and `clean-start` (no prior context).

## Models and usage

- **Model catalog**: Pi's canonical Anthropic metadata intersected with the model IDs Claude Code reports it serves.
- **Account probe**: A one-shot CC query for `accountInfo`/`supportedModels`.
- **First-party account**: Claude Code authentication whose Agent SDK account reports subscription auth, not an API key.

## Tool bridge

- **MCP bridge**: Pi's tools exposed to Claude Code as an in-process MCP server named `custom-tools`, so every tool call flows back through Pi. CC-native tools are disabled (`tools: []`).
