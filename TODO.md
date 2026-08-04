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
  cleaner and resilient to log-format churn. Adding `doppel=<kind>:<key8>` to
  those lines silently broke five session integration tests for three commits
  — they only run against live quota, so nothing caught the drift.

## Upstream Gaps

- **No session-scoped model selection**: `AgentSession.setModel` writes the
  *global* default — `settingsManager.setDefaultModelAndProvider(...)` at
  `core/agent-session.ts:1587` marks `defaultProvider`/`defaultModel` modified
  and saves `~/.pi/agent/settings.json`. The extension API's `setModel` routes
  to the same method, so a provider extension cannot change the session's model
  without changing what every future session starts on, for every provider.
  This blocks matching Claude Code's refusal behavior, which swaps its own
  `mainLoopModel` to the fallback and restores it when the session id changes.
  We do not follow the reroute for that reason: the refusal entry reports it and
  the user picks. Until upstream offers a `persistModelSelection: false` setting
  or a session-scoped setter, the footer, the context-window budget, and the
  in-flight cost figure all name the requested model while Claude serves another
  (the settled turn is re-priced from the served model, so the billed total is
  correct).

## Downstream Integration

- **pi-librarian nested runtimes**: Pass `ctx.modelRegistry.getRegisteredNativeProvider(providerId)` into each fresh `ModelRuntime` with `registerNativeProvider()` so nested calls retain the registered Provider object's runtime closure.

- **pi-sessions nested runtimes**: Apply the same registered-native-Provider propagation when constructing fresh `ModelRuntime` instances.

## Deferred

- **Refused partial output stays in the transcript**: `SDKModelRefusalFallbackMessage`
  carries `retracted_message_uuids` and `refused_user_message_uuid`; Claude Code
  splices those messages out of its own transcript. We cannot act on either
  field yet, and three things are missing.
  First, evidence: it is unconfirmed whether a refused partial ever reaches pi.
  Claude Code's telemetry distinguishes `midStream` refusals and counts
  `discardedBlockCount`, so partials clearly exist upstream — but if the SDK
  withholds them from us until after the refusal, there is nothing to retract
  and this item is moot. Determine this with a live probe before building.
  Second, correlation: the bridge never records SDK assistant message uuids, so
  a retracted uuid cannot be mapped to the content we emitted. Cheap to fix — a
  map in `query-state.ts` keyed by uuid.
  Third, a retraction primitive, which does not exist on either side of the
  boundary. `AssistantMessageEvent` (pi-ai `types.d.ts:365`) has no event
  meaning "discard what I streamed for this message"; once `text_delta` is
  emitted, `partial` carries it to `done`. The extension API offers only
  `appendEntry` (`core/extensions/types.ts:1295`) with no remove or replace, so
  a committed entry cannot be rewritten either. The only mechanism available
  today is buffering each SDK assistant message until the next message proves
  it survived, which trades live streaming for a rare correction. Not worth it.
  Pending upstream support, the refusal entry describing what happened is the
  honest substitute.

- **CC CLI debug log accumulation**: When `DOPPELCLAUDE_DEBUG=1`, every
  `query()` call writes a new file under `~/.pi/agent/cc-cli-logs/`. These
  accumulate indefinitely.
