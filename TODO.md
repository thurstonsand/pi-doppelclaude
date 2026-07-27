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

## Upstream Gaps

- **No reachable networked model refresh**: the catalog discovers only when
  `context.allowNetwork` is true or the store has no entry, and pi 0.82.1's sole
  `allowNetwork: true` caller is `refreshModelCatalogs()` in
  `package-manager-cli.ts`, which builds a bare `ModelRuntime` with no
  extensions loaded. So `pi update --models` cannot reach an
  extension-registered provider, and a bootstrapped installation never
  rediscovers. The documented workaround is deleting the `doppelclaude` entry
  from `models-store.json`. Either ask pi to load extensions for that command,
  or register our own refresh command.

## Downstream Integration

- **pi-librarian nested runtimes**: Pass `ctx.modelRegistry.getRegisteredNativeProvider(providerId)` into each fresh `ModelRuntime` with `registerNativeProvider()` so nested calls retain the registered Provider object's runtime closure.

- **pi-sessions nested runtimes**: Apply the same registered-native-Provider propagation when constructing fresh `ModelRuntime` instances.

## Deferred

- **CC CLI debug log accumulation**: When `DOPPELCLAUDE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.
