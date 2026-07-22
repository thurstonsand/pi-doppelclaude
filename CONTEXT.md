# Claude Bridge

This project exposes Claude Code's Agent SDK as a native Pi model provider while keeping Pi responsible for tools and conversation control.

## Language

**Anthropic Agent SDK provider**:
The Pi provider backed by Claude Code subscription authentication and Agent SDK streaming, identified as `anthropic-agent-sdk`.
_Avoid_: Anthropic provider, Claude Code provider

**Supported model catalog**:
The closed set of stable model IDs with explicit Agent SDK runtime and context-window policy in this extension.
_Avoid_: Anthropic catalog, SDK model list

**First-party Claude Code account**:
Claude Code authentication whose Agent SDK account reports `apiProvider: "firstParty"`.
_Avoid_: API key, Pi login

## Relationships

- The **Anthropic Agent SDK provider** exposes only the **Supported model catalog**
- The **Anthropic Agent SDK provider** requires a **First-party Claude Code account**
