# Relocation spike: CC's rendered prompt per mechanism

Captured from a real Claude Code subprocess (Agent SDK) against a local stub API.
Fixture: the live 3,111-char `mcp` proxy description; CC cap 2048.

## baseline

- tool `mcp` entry at line 2 (`rendered-baseline.txt`)
- CC's cap fired: `[truncated]` at line 8
- no system prompt section

- usage table LOST to the cap
- final instruction bullet LOST

## relocate

- tool `mcp` entry at line 2 (`rendered-relocate.txt`)
- CC's cap did not fire
- system prompt section at line 24
- pointer stub at line 3
- usage table survives at line 32 (system prompt)
- final instruction bullet survives at line 30

## relocate-v2

- tool `mcp` entry at line 2 (`rendered-relocate-v2.txt`)
- CC's cap did not fire
- system prompt section at line 13
- pointer stub at line 3
- usage table LOST to the cap
- final instruction bullet survives at line 14

## splice

- tool `mcp` entry at line 2 (`rendered-splice.txt`)
- CC's cap fired: `[truncated]` at line 8
- system prompt section at line 29

- usage table survives at line 32 (system prompt)
- final instruction bullet survives at line 30

## duplicate

- tool `mcp` entry at line 2 (`rendered-duplicate.txt`)
- CC's cap fired: `[truncated]` at line 8
- system prompt section at line 29

- usage table survives at line 37 (system prompt)
- final instruction bullet survives at line 35

## Serialization order: tools before system (mechanical proof)

The assembled model prompt is not observable client-side — the splice of `tools[]`
into prompt text happens inside Anthropic's servers. `order-probe.ts` extracts the
order mechanically, two independent ways, both from the server's own responses:

1. **The API said so.** Injecting a 5m-TTL cache breakpoint on the last tool ahead
   of CC's 1h system breakpoints drew a 400 whose message states: "blocks are
   processed in the following order: `tools`, `system`, `messages`."
2. **The cache proved it.** With a 1h breakpoint on the last tool: run 1 wrote
   6,061 tokens; run 2 with an *entirely different system prompt* read 5,457 back
   and wrote only 618. A strict-prefix cache surviving a system change means the
   tool block precedes system in the serialized prompt.

Consequences for this design: the `rendered-*.txt` TOOLS-first layout is the true
adjacency; relocated text at the *top* of the pi prompt block sits closest to the
tool definitions; and a mid-session change to relocated text (respawn) invalidates
only the system-and-later cache prefix, not the tool block ahead of it.

Wrinkles hit on the way, worth remembering: haiku ignores cache breakpoints below
its 2,048-token minimum prefix, and the probe's first fixture (one fat tool) was
silently cut to 2,048 chars by the very CC cap this spike investigates — the tool
block must be fattened with many cap-sized tools, not one large one.
