# TODO

## Features

- **Markdown rendering** in expanded tool result view. Currently plain text.
  Use `Markdown` from `@earendil-works/pi-tui` with a `MarkdownTheme`.

- **`/claude config` slash command** for runtime configuration. Currently
  requires editing JSON and `/reload`.

- **`/claude:btw` command** for ephemeral questions: response displayed but
  not added to LLM context.

- **Audit tool parameter mismatches**: The bash timeout default (120s) was added
  because pi's bash has no default while Claude Code expects one. Other bridged
  tools may have similar mismatches (units, defaults, optional-vs-required params).
  Compare Claude Code's tool schemas against pi's for read, write, edit, grep, find.

## Possible Enhancements

- **AskUserQuestion pi shim** (main provider only): CC never sees
  AskUserQuestion (it's in `DISALLOWED_BUILTIN_TOOLS`), so it can't ask the
  user questions interactively. Port a pi-native version using `ctx.ui.custom()`
  for an option picker with free-text fallback. Not applicable to AskClaude
  subagents (can't interact with user). See `fractary/pi-claude-code`
  `AskUserQuestion.ts` for reference.

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
  ExitPlanMode are blocked. A pi-native plan mode could use
  `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
  via `tool_call` event, and surface plan approval through pi's TUI. Not
  applicable to AskClaude subagents. See `fractary/pi-claude-code`
  `PlanMode.ts`.

## Testing Gaps

- **`int-session-resume` Turn 8 flake (low priority)**: The isolated-AskClaude
  assertion fails intermittently (~1-in-5). The alt provider invokes AskClaude
  with a verbatim prompt in some runs (test passes — isolated CC correctly
  returns "UNKNOWN") but may embed the secret word into the prompt in others
  (test fails — but the leak is in the calling model, not in our isolation).
  We confirmed the verbatim case from logs; the failing case wasn't captured
  before the next run overwrote the log. Either pin the alt model to one with
  strict prompt fidelity, or instrument the test to assert on the AskClaude
  prompt args (not just the response) so we can distinguish "calling model
  embedded the answer" from a real bridge-side context leak.

- **Structured diagnostics for tests**: Tests grep debug-log strings to verify
  internal state. The `syncResult:` marker added on `simplify-session-sync`
  narrows this for session sync (tests parse a single targeted line per
  decision instead of the old Case-1/2/3/4 labels), but it's still grep-based.
  A proper diagnostic channel (NDJSON or dedicated diagLog entries) would be
  cleaner and resilient to log-format churn.

## Deferred

- **CC CLI debug log accumulation**: When `CLAUDE_BRIDGE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.
