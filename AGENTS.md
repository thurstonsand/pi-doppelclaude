# AGENTS.md

I love pi's flexibility and extensibility, and want to use it for all of my LLM usage. But for my own personal usage I want to stay with the Anthropic subscription. pi used to support logging in with the Anthropic subscription, but recent policy changes at Anthropic limited the offering to Claude Code or the Agent SDK.

`pi-doppelclaude` enables use of that subscription in the pi harness by bridging the pi session with the Agent SDK session. However, even with that, Anthropic blocks any conversation that contains certain keywords from pi's system prompt. So `pi-doppelclaude` also hooks into the system prompt and replaces pieces of it with user-provided snippets which can never be matched on.

Between the two of those, and setting the right options in the SDK, it's possible to have a basically-native experience inside pi using Anthropic's models.

## Context

See @CONTEXT.md for project vocabulary.

## Tenets

- Division of sovereignty: pi owns tools, history, context, and display; Claude Code owns auth, models, and quota; the bridge manages the connection between them
- Pi owns the session history as the source of truth and tool execution as the actual harness; Claude Code determines which tools to call
- Track the Agent SDK closely; delete workarounds the moment it catches up

## Developer notes

See @DEV.md for setup, commands, code style, and testing.
