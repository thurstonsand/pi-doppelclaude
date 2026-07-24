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
  for an option picker with free-text fallback. See `fractary/pi-claude-code`
  `AskUserQuestion.ts` for reference.

- **PlanMode pi shim** (main provider only): Similarly, EnterPlanMode/
  ExitPlanMode are blocked. A pi-native plan mode could use
  `pi.setActiveTools()` to restrict to read-only tools, block destructive bash
  via `tool_call` event, and surface plan approval through pi's TUI. See
  `fractary/pi-claude-code` `PlanMode.ts`.

## Testing Gaps

- **Structured diagnostics for tests**: Tests grep debug-log strings to verify
  internal state. The `syncResult:` marker added on `simplify-session-sync`
  narrows this for session sync (tests parse a single targeted line per
  decision instead of the old Case-1/2/3/4 labels), but it's still grep-based.
  A proper diagnostic channel (NDJSON or dedicated diagLog entries) would be
  cleaner and resilient to log-format churn.

## Downstream Integration

- **pi-librarian nested runtimes**: Pass `ctx.modelRegistry.getRegisteredNativeProvider(providerId)` into each fresh `ModelRuntime` with `registerNativeProvider()` so nested calls retain the registered Provider object's runtime closure.

- **pi-sessions nested runtimes**: Apply the same registered-native-Provider propagation when constructing fresh `ModelRuntime` instances.

## Deferred

- **Claude Opus 5 catalog enablement**: Pi 0.82.0's published `pi-ai` Anthropic catalog still has no `claude-opus-5`, so adding the ID would make `buildModels()` fail under both the installed Pi 0.81.1 and current 0.82.0. Once a published Pi release contains canonical Opus 5 metadata, raise both Pi peer and development dependency floors to that first containing version, add `claude-opus-5` after Fable in `MODEL_IDS_IN_ORDER`, and authenticate a Claude Code context-window smoke. Add it to `BARE_ONE_M_MODEL_IDS` only if the bare ID serves the catalog's 1M window; otherwise leave the set unchanged so `claudeCodeModelId()` supplies `[1m]` when `contextWindow > 200_000`.

- **CC CLI debug log accumulation**: When `CLAUDE_BRIDGE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.
