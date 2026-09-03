# CONTEXT.md

## Cast

- **Pi**: The host coding agent harness. Owns the TUI, tool execution, conversation history, and context management.
- **Claude Code** / **CC**: Anthropic's coding agent, spawned as a subprocess. Owns authentication, model access, and subscription quota.
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk`, the programmatic interface used to spawn and drive Claude Code `query()` processes.
- **Doppelclaude** / **the bridge**: This extension, published as `pi-doppelclaude`. Presents Claude Code to Pi as a native provider and keeps the two agents' views of the conversation reconciled.

## Provider and runtime

- **Provider**: The native `pi-ai` Provider registered as `doppelclaude`. Pi's canonical model metadata is authoritative for display and behavior; Claude Code executes the requests.
- **Bridge owner**: The process-scoped singleton Provider/runtime pair. The first activation builds and owns it; later activations borrow it, so all provider calls route through one runtime.

## Doppels

- **Doppel**: the Claude Code counterpart of one conversation — its session, query lifecycle, and transcript — keyed by the pi session id the caller sends, or a synthetic key when absent.
- **Host doppel**: the doppel of the pi session hosting this process, designated by `session_start`.
- **Guest doppel**: a doppel keyed by any other pi session id.
- **Ephemeral doppel**: the doppel of a keyless call — title, working vibe.

### Relationships

- One host **doppel** per pi session, for the main conversation
- guest **doppels** are other pi sessions within the same process, different from the host
- ephemeral **doppels** are invocations of Claude Code that have no pi session counterpart; e.g. `streamSimple`
- A single pi session will have exactly one host **doppel**, and any number of guest or ephemeral **doppels**

## Failure handling

- **Dead query**: a Claude Code query that expired out from under a turn, either by a control request rejected by SDK teardown, or OAuth credentials revoked by a sibling process.

## Session sync

- **Sync paths**: `reuse` (Pi's history matches the live session; send only the new tail), `rebuild` (history diverged — including a rewind to a shorter context; synthesize a complete CC transcript and atomically replace the store entry), and `clean-start` (no prior context). Each doppel plans its own.
- **Cursor**: how many of Pi's messages Claude Code has been shown.

## Models and usage

- **Model catalog**: Pi's canonical Anthropic metadata intersected with the model IDs Claude Code reports it serves, plus any **refused fallbacks**
- **Refusal fallback**: CC's safeguards decline a request and the API retries on another model, keeping that conversation on it. Pi still shows the original model, even as Claude Code uses the fallback.
- **Account probe**: A one-shot CC query for `accountInfo`/`supportedModels`.
- **First-party account**: Claude Code authentication whose Agent SDK account reports subscription auth, not an API key.

## Tool bridge

- **MCP bridge**: Pi's tools exposed to Claude Code as an in-process MCP server named `custom-tools`, so every tool call flows back through Pi. CC-native tools are disabled (`tools: []`).
