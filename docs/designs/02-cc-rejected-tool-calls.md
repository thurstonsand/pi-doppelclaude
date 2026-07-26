# Claude Code–Rejected Tool Calls: Dispatch Ground Truth, Mangling, and the Rejection Window

## Status

Accepted

## Decision Summary

Treat Claude Code's transcript as ground truth for which tool calls were dispatched, while continuing to stream the model's raw output to pi. Three coordinated mechanisms make every ordering safe: a strict name gate that emits unrecognized tool names to pi under a `cc_no_such_tool__` marker (persisting the failure in pi's record without executing anything), an always-dispatch MCP validation layer that makes pi the sole argument validator, and a rejection-window buffer that replaces event discard whenever a rejection removes the generator backpressure. The tradeoff: CC-side argument pre-validation is deliberately disarmed in exchange for eliminating the one rejection route the bridge cannot see at emission time.

Resolves the deadlock documented in `docs/investigations/01-unmatched-tool-call-deadlock.md`.

## Problem Statement / Background

The investigation records a production deadlock: the model emitted `tool_use` with the CC-native name `bash` while running with `tools: []` (all pi tools exposed via MCP as `mcp__custom-tools__*`). Three failures compounded:

1. **Name collision → unauthorized execution.** `mapSdkToolNameToPi` checks `SDK_TO_PI_TOOL_NAME` *before* the MCP map, so `bash` mapped to pi's real `bash` tool. Pi executed for ~7s a call Claude Code had already rejected internally ("No such tool available") and never dispatched.
2. **Lost race → discarded correction.** With no MCP handler registered for the rejected call, nothing blocked the SDK generator. CC streamed the model's corrected `mcp__custom-tools__bash` call while `currentPiStream` was null (pi still executing), and the `provider-stream.ts:105` guard discarded every event of it.
3. **Warn-and-hang.** Pi's result for the bad id matched no handler; it was parked in `pendingResults` with a warning, the corrected call's handler blocked the generator forever, and the session hung until manual abort.

The self-healing observed in earlier occurrences was pure ordering luck: when pi's failure was fast (`Tool X not found`), pi re-entered `streamSimple` and claimed a new stream before the correction arrived. The collision made the failure slow, and CC won the race.

Concrete scenarios this design must handle:

- Model emits `tool_use: bash` (or any unregistered name); CC rejects it; pi must not execute its real `bash`, the failure must persist in pi's transcript in position, and the model's follow-up must reach pi whichever side wins the race.
- Model emits a correctly named call whose args fail the bridge's zod translation of pi's TypeBox schema; today the MCP SDK rejects before the handler, silently recreating the no-backpressure race with a *valid* name.
- After a rejection, the model talks at length without tool calls, or ends its turn immediately — pi asked for a continuation and must receive whatever CC produces next.
- Pi takes arbitrarily long (e.g. 20s) to come back after the rejected call; CC's corrected valid call has already dispatched an MCP handler that is blocking the generator; pi's stale result must be dropped and the buffered correction replayed.
- A message mixes one valid and one rejected call; the valid handler's backpressure holds while the rejected id is reconciled.
- A future CC version rejects dispatch through a route we did not predict; the bridge must detect it generically and never hang.

## Goals

- Pi never executes a tool call Claude Code declined to dispatch.
- Rejected tool calls stream to pi live (`toolcall_start`/deltas/`toolcall_end`) and persist in pi's record in position as a `toolCall` plus error `toolResult`, mirroring the `tool_use` + `tool_use_error` pair in CC's own transcript.
- Turn liveness is independent of the pi/CC ordering race; no event of the model's follow-up is ever discarded.
- Unexplained mismatches hard-fail the turn instead of warning and hanging.
- Materialized (rebuilt) CC sessions show the literal tool name the model emitted, matching what CC recorded live.

## Non-Goals

- Cancelling an in-flight pi tool execution from the provider (no channel exists).
- Handling CC-side permission denials as a distinct route — the bridge runs `bypassPermissions`; the generic detector covers the hypothetical.
- Ephemeral UI notifications for rejected calls — the transcript record is the observability (debug log retained).
- Preserving `SDK_TO_PI_TOOL_NAME` / `SDK_TO_PI_ARG_NAMES` live-path mapping of CC-native names to pi tools. With `tools: []` that mapping is definitionally a collision, never a feature.

## Exposed Shape

### Pi transcript (user-visible record)

A CC-rejected call appears as a normal tool call turn:

- `toolCall` block, name `cc_no_such_tool__<literal>` (e.g. `cc_no_such_tool__bash`), arguments exactly as the model emitted them.
- Error `toolResult` from pi's own agent loop: `Tool cc_no_such_tool__bash not found`.
- Token usage for the turn accrues normally.

The marker is deliberately explicit: the pi TUI shows precisely what happened and who rejected it.

### CC session record (live and rebuilt)

- Live: CC already records `tool_use: bash` + synthesized `tool_use_error` — untouched.
- Rebuilt from pi history: `mapPiToolNameToSdk` strips the `cc_no_such_tool__` marker first and emits the literal name, so the rebuilt record converges with what CC recorded live. Pi's error `toolResult` materializes as an `is_error` tool_result.

### MCP tool contract (bridge ↔ CC)

- Advertised schemas are pi's TypeBox schemas verbatim.
- Validation never rejects: every correctly named call reaches the handler and blocks the generator. Pi's `validateToolArguments` is the single authority on argument validity; its verdict flows back through the handler as an ordinary result.

### Provider stream contract (bridge ↔ pi)

- Unchanged event vocabulary. New guarantee: after a known rejection ends a stream, SDK messages arriving before pi's next `streamSimple` are buffered and replayed on claim, in order, instead of discarded. Outside a rejection window, the stale-discard behavior at `provider-stream.ts:105` is untouched.
- Tool results delivered by pi for CC-rejected ids are dropped, not forwarded and not parked.
- Impossible states (result for an id never shown to pi; handlers still waiting after full result delivery) terminate the turn via `emitTerminalError` — pi surfaces a real error and the session stays usable.

## Design Decisions

### 1. CC's transcript is ground truth for dispatch

The bridge streams the model's raw output for fidelity but does not infer dispatch from it. Dispatch is what CC actually did: handler invocation is the positive signal; CC's synthesized `tool_use_error` (visible as a `tool_result` block in an SDK `user` message for an id the handler never saw) is the negative signal. This detector is route-agnostic — it catches name rejection, schema rejection, and any rejection route a future CC version invents, because CC *must* synthesize a tool_result for every tool_use to continue the conversation.

Ordering invariant that makes the detector sufficient: CC must deliver the synthesized tool_result to the API before the model can begin generating its response to it, so rejection detection strictly precedes any event that needs buffering.

### 2. Name gate with `cc_no_such_tool__` mangling at emission

`mapSdkToolNameToPi` becomes an exact lookup in `customToolNameToPi`; any miss returns `cc_no_such_tool__<literal>`. Consequences, in order of importance:

- Pi cannot match a real tool — the unauthorized-execution class is dead, including the near-miss variants (the old prefix-strip fallback could map an invented `mcp__custom-tools__bassh` onto arbitrary pi names).
- Pi's failure is microseconds (`agent-loop` not-found), so the window between stream-end and pi re-entry collapses — the race trigger that caused the incident (slow collided execution) is gone.
- The failure persists in pi's record in position, with the model's literal arguments untouched (no arg renames apply — fidelity over convenience for a call that will never execute).
- `SDK_TO_PI_TOOL_NAME`, the prefix-strip fallback, the passthrough, and `SDK_TO_PI_ARG_NAMES` renames leave the live path. The bash `timeout` default remains (it serves legitimately mapped MCP bash calls). `PI_TO_SDK_TOOL_NAME`/`pascalCase` remain in `mapPiToolNameToSdk` for materializing history that predates this design or came from other providers, plus the new marker strip.

Marker chosen over alternatives (`unavailable__`, `rejected__`) for explicitness: it names the actor (CC) and quotes its phrasing ("No such tool available").

### 3. Always-dispatch MCP validation — pi is the sole validator

The zod schemas handed to `createSdkMcpServer` are the bridge's own lossy translation of pi's TypeBox schemas (`jsonSchemaToZodShape`). Any strictness delta between "CC validation" and pi is a translation artifact; when the translation is stricter, the MCP SDK rejects before the handler and silently recreates the no-backpressure race with a valid name — invisible to the name gate.

Decision: keep schema *advertisement* (the model still sees pi's parameter shapes) but disarm the *rejecting* role. Implementation settled this differently than first drafted, and the simpler answer is to stop translating at all: `buildMcpServers` uses the low-level MCP `Server` instead of `createSdkMcpServer`, registers one `tools/list` handler that returns `tool.parameters` verbatim, and routes every known name straight to the blocking handler. `typebox-to-zod.ts` is deleted.

The originally drafted mechanism — wrapping each zod property in `.catch(ctx => ctx.input)` — is not viable: zod v4 refuses to serialize a dynamic catch (`Dynamic catch values are not supported in JSON Schema`), so `tools/list` throws, and a static catch value serializes as `default` and drops the key from `required`. Advertising the TypeBox schema directly is both the fix and an upgrade in fidelity: unions, literals, and nested objects survive where the translation flattened objects to `record(unknown)`. `Server`'s `@deprecated` tag steers high-level users toward `McpServer`, whose pre-handler validation is precisely what must be escaped; the tag sanctions low-level use for advanced cases.

Result: "streamed tool_use with a valid name implies dispatch" becomes a true invariant. Malformed args reach pi, whose `validateToolArguments` runs against the authoritative TypeBox schema and produces a proper error result that flows back through the blocked handler. There are no longer two validators to drift apart.

### 4. Rejection window: buffer instead of discard

The `:105` null-stream discard is correct between turns (stale previous-turn messages) and wrong exactly when a rejection has removed backpressure. The window makes that distinction explicit:

- **Open:** when a turn ends whose calls include a mangled name (known at emission), or when the generic detector (Decision 1) identifies a rejected id while `currentPiStream` is null.
- **While open:** SDK messages that drive the pi stream (`stream_event`, `assistant`, `result`) are buffered in arrival order. `system`, `rate_limit_event`, and `user` messages process live (they never touch the pi stream; `user` feeds the detector).
- **Close:** pi's next `streamSimple` claims a stream; buffered messages replay through the same dispatch switch `consumeQuery` uses, then live flow resumes.

Bounded by construction: pi's agent loop always re-enters after a `toolUse`-stopped turn (the mangled call fails in microseconds), and CC's first valid dispatch re-establishes handler backpressure — so CC's maximum lead over pi is one assistant message, which is exactly what the buffer holds. `result` is buffered rather than processed early so command-completion bookkeeping keeps its ordering relative to the streamed content when the model's post-rejection message ends the turn.

### 5. Reconciliation replaces warn-and-park; impossible states hard-fail

Query-scoped sets on `QueryContext` — `shownToolCallIds` (accumulating; replaces the per-message `turnToolCallIds` reset semantics for detection), `dispatchedToolCallIds` (handler invoked, either branch), `rejectedToolCallIds` (detector or name gate) — make classification order-independent. Tool-result delivery becomes:

1. Handler waiting → resolve (unchanged).
2. Id in `rejectedToolCallIds` → drop with debug log. CC already holds its own error result for that id; forwarding pi's would be a duplicate answer to a question CC considers closed.
3. Id in `shownToolCallIds` → park in `pendingResults` for a handler that has not fired yet (unchanged legitimate race).
4. Otherwise → `emitTerminalError`: pi delivered a result for a call it was never shown; that is a bridge bug, and a terminated turn beats a silent hang.

Likewise, handlers still waiting after a full result delivery — previously the deadlock's warning symptom — now hard-fail the turn. The abort path (resolve-with-"Operation aborted") runs first and is unaffected.

## Edge Cases & Failure Modes

- **Correction beats pi's re-entry (the incident ordering):** correction events buffer; pi's stale result drops; replay on claim. No loss.
- **Pi beats the correction (the lucky ordering):** buffer is empty at claim; events flow live. Identical outcome.
- **Post-rejection message is pure text, long or short:** buffered head + live tail stream to pi's new turn; ends `stop`. Buffer stops growing at pi's re-entry, not at CC's pleasure.
- **CC "ends turn immediately" after the rejected call:** impossible in the strict sense — CC must synthesize a tool_result to continue, and the model then produces some response to it. A near-empty response plus the SDK `result` message replays in order; the existing no-stream-event fallback in `processResultMessage` covers the empty message.
- **Mixed valid + rejected calls in one message:** the valid handler blocks the generator (buffer stays near-empty); pi executes both — the mangled one fails instantly — and delivery resolves one, drops the other.
- **Pi delayed arbitrarily after rejection:** CC's lead is capped at one message by handler backpressure; see Decision 4.
- **Query aborted/closed mid-window:** `closeQueryContext` discards the buffer along with pending state; handlers already resolve with "Operation aborted"/"Query ended".
- **Args not an object at all:** the MCP SDK's object-level parse would still reject, but `tool_use.input` is structurally always an object; theoretical.
- **Missing required argument under catch-passthrough:** the property catch yields `undefined`; pi's TypeBox validation fails it properly and the error result flows back through the handler.
- **Marker-named block found during materialization:** strip marker, emit literal name; pi's error `toolResult` becomes an `is_error` tool_result — converges with CC's live record.

## Alternatives

### Emit tool calls to pi only on MCP dispatch

- **Status:** Rejected
- **Decision:** Destroys streaming — dispatch fires only after arguments complete, so pi would receive every tool call as a post-hoc lump, violating the streaming requirement for the 99% healthy path to fix a 1% failure.
- **Discussion:** Was the investigation's "cleanest" candidate for making "streamed implies dispatched" true. The always-dispatch validation (Decision 3) achieves the same invariant for valid names without the cost.

### Keep CC-side validation; handle schema rejects via the detector only

- **Status:** Rejected
- **Decision:** The detector fires while pi is already executing (valid name → pi was shown the call), and the provider has no cancel channel into pi's executor — pi may complete a call CC declined, violating the core invariant. Also leaves CC's record (synthetic error) permanently diverged from pi's (real result).

### Inject rejected calls as out-of-position CustomMessages / synthetic text

- **Status:** Rejected
- **Decision:** The investigation's original objection stands: transcript corruption risk, out of position. Mangling makes the failure representable *in position* as a normal toolCall + toolResult pair, which is strictly better and also round-trips through materialization.

### Ephemeral `piUI.notify` for rejected calls

- **Status:** Rejected
- **Decision:** Was a workaround for having no record. The record now exists; a debug log suffices.

## Implementation Plan

- [x] Phase 1: Name gate, mangling, and materialization round-trip
  - Goal: Unauthorized execution impossible; rejected calls persist in pi's record; rebuilt CC sessions show the literal name.
  - Files: `src/convert.ts`, `tests/unit-import.ts` or dedicated convert unit test, `CHANGELOG.md`
  - Work: Export `CC_REJECTED_TOOL_PREFIX = "cc_no_such_tool__"` and `isCcRejectedToolName()`. Rewrite `mapSdkToolNameToPi` as exact `customToolNameToPi` lookup (case-insensitive as today) with mangle fallback; delete `SDK_TO_PI_TOOL_NAME`, prefix-strip, passthrough. Strip `SDK_TO_PI_ARG_NAMES` renames from `mapSdkToolArgsToPi`, keep bash timeout default. Add marker strip as the first step of `mapPiToolNameToSdk`.
  - Validation: unit tests — `bash` → `cc_no_such_tool__bash`; registered `mcp__custom-tools__bash` → `bash`; `mcp__custom-tools__bassh` (unregistered) → mangled, not stripped; `mapPiToolNameToSdk("cc_no_such_tool__bash")` → `bash`; round-trip through `convertPiMessages`. `npm test`.

- [x] Phase 2: Always-dispatch MCP validation
  - Goal: Every correctly named call reaches the handler; pi is the sole argument validator.
  - Files: `src/bridge-runtime.ts`, `src/typebox-to-zod.ts` (deleted), `tests/unit-mcp-dispatch.ts`, `CHANGELOG.md`
  - Work: Replace `createSdkMcpServer` with the low-level MCP `Server`; advertise `tool.parameters` verbatim and dispatch every known name to the handler (see Decision 3 for why the drafted zod `.catch` mechanism was abandoned).
  - Validation: unit — invalid-typed args pass through unchanged; missing required key yields `undefined` reaching the handler. Smoke — real CC session, confirm `tools/list` advertisement unchanged (schema fields, required, descriptions) and a deliberately malformed call reaches pi and produces pi's validation error as the tool result.

- [x] Phase 3: Rejection tracking, window buffering, reconciliation
  - Goal: No ordering can lose events or hang; pi's results for rejected ids are dropped; impossible states hard-fail.
  - Files: `src/query-state.ts`, `src/provider-stream.ts`, `src/bridge-runtime.ts`, `tests/unit-provider-errors.ts` (or sibling), `CHANGELOG.md`
  - Work: Add `shownToolCallIds`/`dispatchedToolCallIds`/`rejectedToolCallIds` sets and the message buffer to `QueryContext`; retire `turnToolCallIds` in favor of the sets (update `contextForToolResults`). Extract a `dispatchSdkMessage` used by both the `consumeQuery` loop and buffer replay. Open the window at rejected-name stream end and on detector hits (`user`-message `tool_result` for shown-but-undispatched ids); buffer `stream_event`/`assistant`/`result` while open; close and replay in `claimCurrentPiStream`. Record dispatch in `createMcpToolHandler`. Rewrite result delivery per Decision 5; replace the still-waiting-handlers warning with `emitTerminalError`; clear buffer in `closeQueryContext`.
  - Validation: unit tests with fake SDK message sequences — incident ordering (correction before re-entry) end-to-end; lucky ordering; pure-text follow-up with buffered `result`; mixed valid+rejected message; unknown-id result → terminal error. Full `npm test` plus an int smoke run outside the sandbox.

- [x] Phase 4: Investigation closure and docs
  - Goal: The investigation doc points at the resolution; user docs reflect behavior.
  - Files: `docs/investigations/01-unmatched-tool-call-deadlock.md`, `README.md`/docs if they describe tool mapping, `CHANGELOG.md` (consolidated entry)
  - Work: Add a resolution note referencing this design. Run the update-docs pass.
  - Validation: docs review; changelog entry consolidated under UNRELEASED.
