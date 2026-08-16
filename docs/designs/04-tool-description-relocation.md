# Tool Description Relocation

## Status

Accepted

## Decision Summary

Claude Code truncates every MCP tool description at a hard-coded cap (2048 chars as of CC 2.1.22x) when rendering it into the model prompt. For bridged pi tools whose descriptions exceed the cap, the bridge advertises a short pointer stub over MCP and carries the full description in the system prompt, where no cap applies. The cap is recovered from the CC binary by a cached probe rather than hard-coded, trading a startup scan for resilience to CC version drift.

## Problem Statement / Background

The pi-mcp-adapter's `mcp` proxy tool concentrates an entire MCP gateway into one tool description: server list, per-server instructions, usage table, mode precedence. With one server (`ha-mcp`) configured to inline its full 1,857-char MCP `instructions`, that description reaches 3,111 characters.

Claude Code renders each MCP tool into the prompt via a `prompt()` accessor that hard-slices at a minified constant (`sne`/`Dre` = 2048, depending on build) and appends `… [truncated]`. The observed result in a live doppelclaude session: the model's copy of the `mcp` description stops mid-bullet at byte 2048, losing the tail of the server instructions *and the entire usage table* — the tool's own calling conventions. The same session running through the OpenAI provider sees everything, because only the Claude Code path truncates.

The constant is lexical — no env var, no SDK option (`MCP_TOOL_TIMEOUT` and `MCP_CONNECTION_NONBLOCKING` exist; nothing for length). The fix cannot live in the pi-mcp-adapter without baking one host's quirk into a host-agnostic package. It belongs in the layer that introduced Claude Code into the stack: this bridge.

The bridge holds both ends of the escape route. It owns the ListTools response (what CC sees as the tool description) and the system prompt it hands CC (which CC does not cap). Relocating oversized descriptions from the capped surface to the uncapped one makes CC's truncation unreachable.

## Goals

- A bridged pi tool with a description of any length reaches the model intact through Claude Code.
- Zero configuration for the default case; the mechanism keys off the actual CC binary in use.
- Failure of any part degrades to today's behavior (truncation at 2048), never worse.

## Non-Goals

- Fixing or configuring Claude Code's cap itself (upstream, lexical constant).
- Making the pi-mcp-adapter aware of Claude Code (host-agnostic package; its own `instructionsLength` knob is a separate, complementary change).
- Relocating MCP *server* instructions of servers CC connects to directly (none exist in this bridge; CC-native tools are disabled).
- The compaction path (`tools: []`, no MCP servers — nothing to relocate).

## Exposed Shape

**Settings** (pi `settings.json`, global or project):

```jsonc
{
  "doppelclaude": {
    "provider": {
      "toolDescriptionCap": 2048  // unset = probe the CC binary, fallback 2048
                                  // number = manual cap, no probe
                                  // false  = relocation disabled
    }
  }
}
```

**MCP bridge → Claude Code** (ListTools): a relocated tool advertises an **empty description** — name and schema unchanged, so it stays fully callable, but no redirect verbiage occupies the tool list. Tools at or under the cap advertise their descriptions unchanged.

**System prompt → Claude Code**: a relocation block spliced into the pi prompt's own tool documentation — directly above the "In addition to the tools above…" line that closes the Available tools list — a distinctly-tagged namespace carrying prose only, one entry per relocated tool, with no preamble of the bridge's invention:

```
<extended_function_descriptions>
<function_description>{"name":"{sdk name}","description":"{entire original description}"}</function_description>
</extended_function_descriptions>
```

The tool's `parameters` schema is deliberately absent — it is already advertised in the ListTools entry, and nothing is declared twice: the tool entry owns the callable machinery (name, schema), the block owns every byte of prose.

The Anthropic API serializes `tools` before `system` (proven mechanically — see Design Decision 6), so this placement puts the relocated definitions a few lines below the real `</functions>` block, separated only by CC's injected preamble line and the identity paragraph. In `"pi"` and `"append"` modes the block rides the rewritten pi prompt; in `"claude-code"` mode it rides the preset's `append` field. CC renders MCP tool descriptions independently of the `systemPrompt` option, so the cap fires in all three modes and relocation applies to all three.

**Probe ↔ CC binary**: read-only anchored scan of the executable the SDK will spawn (`pathToClaudeCodeExecutable` if set, else the SDK's platform package `@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude`). Produces a number or falls back to 2048.

## Design Decisions

### 1. Relocate, not splice or duplicate

Three mechanisms were considered: splice the post-2048 overflow into the system prompt (zero duplication, but welded to CC's exact slice point — silent gap or overlap when the constant drifts), duplicate the full description in both places (robust, ~2KB duplicated per oversized tool per request), and relocate (stub advertised, full text in system prompt only). Relocation is the only shape where correctness never depends on reverse-engineered CC internals: the cap decides *when* to relocate, never *where* to cut. Its cost is weaker adjacency between the tool entry and its description, mitigated by a deterministic section label the stub names exactly.

### 2. Generic over all bridged tools

Any pi tool crossing the bridge gets the treatment when its description exceeds the cap. The bridge does not know the mcp-adapter exists; today only the `mcp` proxy tool trips the threshold, but the defect is per-tool and any extension can ship a long description.

### 3. Cap recovered by probing the CC binary

The constant's minified identifier is build-noise (`sne` in standalone 2.1.223, `Dre` in the SDK-bundled 2.1.221), but the log message referencing it is a stable string literal: `` `Server instructions truncated from ${x.length} to ${IDENT} chars` ``. The probe scans the binary for that anchor to learn the identifier, then for `IDENT=<digits>` to learn the value. Validated against both binaries; both yield 2048. Guards: accept a single distinct value within 256–65536; on multiple candidates prefer the assignment nearest the anchor; on none/ambiguity fall back to 2048 with a debug log **and a user-visible Pi warning** — the fallback means CC changed shape and the cutoff needs re-verifying, and the operator should hear about it without reading debug logs. The warning fires once per binary version (it is cached alongside the probe result), not per turn. Results are cached by binary path + mtime + size, so the scan (a few hundred ms of chunked reads over ~270MB) runs once per CC version. The probe runs async at bridge startup; turns planned before it resolves use 2048. Being wrong costs at most the status quo: a tool between the true and assumed cap is truncated (as today) or relocated unnecessarily (harmless).

### 4. Empty stub, no preamble

A relocated tool's advertised description is the empty string, and the relocation block carries no preamble line. Earlier iterations used a pointer stub ("full definition appears in the system prompt") and a one-line preamble; both were removed on the judgment that the `<function>` block — sitting two lines below the real `</functions>` with an identical name — reads as a seamless continuation of the tools block, making redirect verbiage noise. The accepted risk: tool selection scans descriptions, and an empty one forces the model to the relocated definition; adjacency keeps that cost low, and the interpretation smoke validates it. A "first-N-chars" stub remains the recorded fallback if the smoke shows the model failing to associate the empty entry with its definition.

### 5. Relocated text rides `spawnSignature`

The relocation section is part of the system prompt built in `planTurn`, which already folds `systemPrompt` into `spawnSignature`. A mid-session change to an oversized description therefore replaces the CC process (with session resume) instead of the cheap in-place MCP reconcile that description changes trigger today. Accepted deliberately: if the model's primary copy of a description lives in the system prompt, a stale copy is a lie, and the event is rare (adapter metadata refreshes; `freezeDirectTools` exists upstream for users who want none). Short-description changes still take the reconcile path — `mcpSignature` continues to hash the *original* tool list. Because tools precede system in the serialized prompt, such a respawn invalidates the cache only from the system blocks onward; the tool-block prefix stays warm.

### 6. Relocated block in harness vocabulary, placed after the identity paragraph

The wire spike (`diag/relocation-spike/`) settled two facts that shaped the block's form. First, the Anthropic API serializes the prompt as `tools`, `system`, `messages` — stated verbatim by an API 400 about cache-breakpoint ordering, and confirmed by a cache experiment in which 5,457 of 6,061 cached tokens survived a complete system-prompt swap with tools held constant (`order-probe.ts`). The top of the pi prompt is therefore the closest addressable point to the model's real tools block. Second, an invented heading (`## Full description: {name}`) placed near pi's `Available tools:` list inherits the full size of the production prompt between the tools block and the section; placement at the top is invariant to prompt growth.

The block was initially rendered in the harness's own `<function>{json}</function>` vocabulary, complete with `parameters`, on the theory that byte-identical mimicry maximizes association. That rationale was abandoned once the advertised entry kept the schema: duplicating `parameters` declared the same contract twice, and without the schema the entry is no longer a function definition at all. The final form is a distinct `<extended_function_descriptions>` wrapper of `<function_description>{name, description}` entries — an honest, labeled lookup structure (name leads as the key) spliced directly above pi's unconditional "In addition to the tools above…" line, so the block sits inside the prompt's own tool documentation and that sentence retroactively covers it. Placement went through three iterations: after-identity (preserving pi's identity-first convention), then top-of-prompt (maximal adjacency to the tools block), then here — the live prompt dump showed CC's injected "You are a Claude agent…" sentence wedging between `</functions>` and a top-placed block, breaking the continuation illusion that placement was buying. Semantic integration with pi's tool list won over raw proximity. The anchor is the same class as the existing `toolNameNote` splice; when absent (future pi rewording), the block prepends to the top of the prompt — presence beats placement.

## Edge Cases & Failure Modes

- **Probe finds no anchor (CC rewrote the log message):** fallback 2048, debug log, and a user-visible warning naming the binary and the assumed cap. Status quo prompt behavior.
- **Probe finds identifier but multiple assignment values:** nearest-to-anchor wins; out-of-bounds values discarded; ambiguity → fallback.
- **CC binary missing/unreadable at probe time:** fallback 2048; the SDK will surface the real spawn error on its own.
- **Description exactly at the cap:** not relocated (`>` comparison); CC's own `<=` check means it passes through untruncated.
- **Multiple oversized tools:** each gets its own `## Full description: {name}` block under one shared preamble; stubs are distinguishable only by name (accepted with stub decision).

- **Cap probe resolves after first turn planned:** first turn uses 2048; if the probed value differs, the next turn's `spawnSignature` changes and respawns once. Harmless and self-correcting.
- **`toolDescriptionCap: false`:** bridge byte-identical to today.

## Alternatives

### Overflow splice (advertise unchanged, system prompt carries `description.slice(cap)`)

- **Status:** Rejected
- **Decision:** Correctness depends on CC's exact slice point; a CC release changing the constant produces a silent gap or duplicated seam mid-sentence. The probe reduces but cannot eliminate the window (stale cache, probe fallback while true cap changed).
- **Discussion:** Zero duplication and perfect adjacency made this attractive; determinism of the hard slice at 2048 was verified. It lost on failure mode, not on cost.

### Full duplicate (advertise unchanged, system prompt carries the whole description)

- **Status:** Rejected
- **Decision:** Pays ~2KB per oversized tool on every prompt-cache miss, forever, to buy robustness that relocation gets for free.

### Heading-style section near `Available tools:` (spike variant "relocate v1")

- **Status:** Rejected
- **Decision:** An invented `## Full description:` heading in the middle of the prompt is the bridge's own vocabulary, not the harness's, and its distance from the model's tools block grows with the production prompt. The `<function>` form at the top reads as a continuation of the block it supplements and its adjacency is constant.
- **Discussion:** Chosen initially; overturned by the rendered spike output and the serialization-order proof.

### Stub with leading description fragment (`truncateAtWord(description, ~100)` + pointer)

- **Status:** Open
- **Open Issue:** Empty descriptions make co-relocated tools illegible at a glance in the tool list; the model must associate the bare entry with its relocated definition.
- **Discussion:** Rejected as arbitrary across generic tools, but pi itself derives prompt snippets this way (`truncateAtWord(spec.description, 100)`), so a generic form exists if needed.
- **Next step:** The interpretation smoke asks a fresh pi instance how it reads the empty entry and the relocated block; revisit if the association fails.

### Fix in pi-mcp-adapter (clamp/reorder for 2048)

- **Status:** Rejected
- **Decision:** Bakes one host's lexical constant into a host-agnostic package; stock pi sessions hit no cap at all. The adapter's own `instructionsLength` setting and section ordering are independent improvements, not substitutes.

### Startup probe via spawning `rg`/`strings`

- **Status:** Rejected
- **Decision:** External-tool dependency for a scan Node can do in-process with chunked reads; the probe is not latency-critical.

## Implementation Plan

- [x] Phase 1: Relocation with a configured or default cap
  - Goal: The fix itself — an oversized bridged description reaches the model intact, with the cap taken from settings or the 2048 default. No probe yet; `unset` behaves like 2048 for now.
  - Files: `src/settings.ts`, `src/turn-plan.ts`, `src/system-prompt.ts`, `src/bridge-runtime.ts` (only if the tool hand-off needs re-plumbing), `tests/unit-settings.ts`, `tests/unit-system-prompt.ts`, new `tests/unit-relocation.ts`
  - Work:
    - `toolDescriptionCap?: number | false` in `PROVIDER_SETTINGS_SCHEMA` and `ProviderSettings`; validated at the settings edge like every other field.
    - `resolveMcpTools` (or a sibling pure function in `turn-plan.ts`) takes the effective cap and returns the advertised tool list — stub descriptions for tools over the cap — plus the relocation entries (sdk name, full description, parameters).
    - `system-prompt.ts` gains the splice: render relocation entries as `<function>{json}</function>` lines under the one-line preamble, inserted directly after `replacements.identity`; prepend when the anchor is missing. `"claude-code"` mode carries the block in the preset `append`.
    - `planTurn` wires the two together; `spawnSignature` picks the block up for free via `systemPrompt`; `mcpSignature` keeps hashing the original tool list.
    - `false` disables everything; descriptions at or under the cap pass through byte-identical.
  - Validation: `mise run check`. Unit coverage: stub + block for an oversized tool; byte-identical pass-through under the cap; anchor-missing prepend; all three `systemPromptMode`s; oversized-description change flips `spawnSignature`, short-description change flips only `mcpSignature`; `false` restores today's plan output exactly.

- [x] Phase 2: Cap probe with fallback warning
  - Goal: `unset` means "probe the actual CC binary", so the cap tracks CC upgrades; fallback to 2048 is loud.
  - Files: new `src/description-cap.ts`, `src/index.ts` (activation wiring), `src/settings.ts` (unset semantics), new `tests/unit-description-cap.ts`
  - Work:
    - Probe: resolve the target binary exactly as the SDK does (`pathToClaudeCodeExecutable` else the `@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude` platform package); chunked scan for the `` `truncated from ${x.length} to ${IDENT} chars` `` anchor, then `IDENT=<digits>`; accept a single distinct value in 256–65536, prefer nearest-to-anchor on multiples, else fall back.
    - Cache keyed by binary path + mtime + size, stored beside the bridge's other agent-dir state; the fallback flag is cached too so the warning fires once per binary version.
    - On fallback: `debug()` log plus `ctx.ui?.notify?.(…, "warning")` naming the binary and the assumed cap (the existing user-visible path, see the compact-failure notice in `src/index.ts`).
    - Async at activation; turns planned before resolution use 2048 — a later differing probe result changes `spawnSignature` once, self-correcting.
  - Validation: `mise run check`. Unit fixtures are small synthetic "binaries" exercising found / missing-anchor / ambiguous / out-of-bounds / cache-hit / cache-invalidation paths. Manual: run the probe against both real binaries (SDK platform package and `~/.local/share/claude/versions/*`) and confirm 2048.

- [ ] Phase 3: Live evidence and docs
  - Goal: Proof the model actually reads relocated text, and the paper trail.
  - Files: `README.md`, `CHANGELOG.md`, `DEV.md` (only if debugging surface changed), this doc
  - Work:
    - Wire smoke: rerun the spike capture against the real bridge (`pi -ne -e ./src/index.ts` path) and confirm the outgoing request advertises the stub and carries the block after the identity paragraph.
    - Interpretation smoke: fresh pi session on the local build with the ha-mcp `.mcp.json` fixture; ask the model — without tool calls — to recite the final Blueprint bullet of ha-mcp's instructions and to describe how it understands the `mcp` tool given the stub. This is the acceptance test for the pointer-only stub (the open alternative); if the model misreads the stub, revisit with the fragment variant.
    - Document `toolDescriptionCap` in README settings; changelog entry.
  - Validation: `mise run check`; the two smokes above, with the recitation transcript kept in `diag/relocation-spike/`.
