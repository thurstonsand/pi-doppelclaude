# Doppelclaude

This project exposes Claude Code's Agent SDK as a native Pi model provider while keeping Pi responsible for tools and conversation control.

## Language

**Doppelclaude provider**:
The Pi provider backed by Claude Code subscription authentication and Agent SDK streaming, identified as `doppelclaude`.
_Avoid_: Anthropic provider, Claude Code provider

**Supported model catalog**:
The stable model IDs Claude Code currently advertises, described by Pi's canonical Anthropic metadata and cached per installation.
_Avoid_: Anthropic catalog, SDK model list

**First-party Claude Code account**:
Claude Code authentication whose Agent SDK account reports `apiProvider: "firstParty"`.
_Avoid_: API key, Pi login

## Relationships

- The **Doppelclaude provider** exposes only the **Supported model catalog**
- The **Doppelclaude provider** requires a **First-party Claude Code account**
