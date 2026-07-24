# Native Anthropic Agent SDK Provider

## Status

Draft

## Decision Summary

Replace the legacy provider-config adapter with a complete Pi 0.81.1 native Provider named `anthropic-agent-sdk`, after first removing the AskClaude delegation feature and extracting the provider runtime from the extension entrypoint. Pi's canonical model metadata becomes authoritative, Claude Code remains responsible for first-party authentication, and no compatibility alias, legacy settings support, or dual provider path survives.

## Problem Statement / Background

The extension currently presents Claude Code through Pi's legacy `registerProvider(name, config)` compatibility shape. That forces the extension to supply a fake API key, a synthetic endpoint marker used for behavior checks, partial model definitions, and only `streamSimple`; Pi then constructs the effective provider around those values. Pi 0.81.1 can instead register a complete `pi-ai` Provider whose authentication, model catalog, filtering, and stream behavior are owned by the extension.

The current extension also contains a separate AskClaude tool for delegating from another provider. That feature is no longer wanted. Its configuration, one-shot query/session behavior, TUI rendering, tests, and documentation enlarge the same entrypoint that owns the provider state machine. Removing it first creates a cleaner boundary for the provider migration.

`src/index.ts` is currently responsible for extension registration, debug plumbing, compaction, session synchronization, MCP tool delivery, persistent Agent SDK queries, and AskClaude. Removing AskClaude still leaves roughly 950 lines with unrelated lifecycle and runtime concerns. The migration should prefactor this structure so the eventual native Provider is a small composition over an explicit bridge runtime rather than another registration block embedded in the entrypoint.

Concrete scenarios this design must handle:

- A user selects `anthropic-agent-sdk/claude-opus-4-8`; Pi invokes the native Provider, while Claude Code supplies authentication and model execution.
- Claude Code is logged out; the provider's models are unavailable without creating or storing credentials in Pi.
- Account probing fails or reports a non-first-party backend; Pi surfaces a provider error rather than guessing.
- `models.json` changes fields on a supported model through `modelOverrides`; the final model metadata controls both Pi behavior and the Claude Code request form.
- `models.json` adds an unknown model or changes provider transport metadata; the model is hidden and direct selection ends in a terminal provider stream error before Claude Code starts.
- A nested Pi runtime uses the provider while a parent bridge query is active; tool results must reach the QueryContext that owns the corresponding Claude Code MCP call.
- Pi generates a compaction summary through the isolated Agent SDK stream; the resulting compaction entry records real usage instead of synthetic zero usage.
- Claude Code falls back to a different concrete model; Pi prices the turn from the SDK's canonical served-model usage instead of the requested model.
- Pi's available tool set changes while a persistent query is alive; the bridge reconciles MCP servers through the SDK control channel instead of discarding the process and its warm state.
- An interrupted turn leaves queued input behind; the bridge uses the SDK interrupt receipt and aborted-message metadata to decide whether the query remains reusable.
- Claude Code reports a subscription or model-scoped usage limit; Pi presents the structured limit and reset information without parsing human prose.
- SessionStore mirroring or resume materialization fails; the bridge treats the authoritative transcript as compromised, surfaces the failure, and rebuilds from Pi history rather than silently continuing with incomplete state.

## Goals

- Register a complete Pi 0.81.1 Provider under the stable provider ID `anthropic-agent-sdk`.
- Keep the extension's entire Pi registration and event surface visible in `src/index.ts`; do not pass `ExtensionAPI` outside that module.
- Remove AskClaude completely, including settings and compatibility handling.
- Make Pi's canonical catalog authoritative for supported model metadata while retaining an explicit, ordered allowlist of stable full model IDs.
- Represent Claude Code authentication truthfully as ambient, first-party authentication owned outside Pi.
- Preserve the persistent query, session synchronization, MCP tool bridge, reentrant call, cancellation, and compaction behavior already established by integration tests.
- Include nested Agent SDK and isolated-compaction usage in the appropriate Pi session entries without double counting normal provider turns.
- Fail fast on unsupported model identity or transport metadata.
- Use Agent SDK 0.3's served-model, interrupt, MCP reconciliation, rate-limit, lifecycle, and SessionStore signals instead of duplicating those protocols through bridge inference.

## Non-Goals

- Preserve or migrate legacy provider identities, stored session selections, or provider-specific `models.json` configuration.
- Retain an alias or dual registration path.
- Support AskClaude settings or resumed AskClaude tool calls.
- Implement a Pi-owned Claude login or credential store.
- Support Bedrock, Vertex, Foundry, gateway, or other non-first-party Claude Code backends.
- Derive the public catalog from Claude Code's mutable model aliases or human-readable descriptions.
- Probe models with paid requests to discover context or output limits.
- Predict whether usage credits are enabled before requesting a long-context model.
- Rewrite historical CHANGELOG entries that accurately describe released versions.

## Exposed Shape

### Pi extension surface

`src/index.ts` is the only module that receives `ExtensionAPI`. It performs every registration in one place:

- register the native Provider;
- register session, model-selection, compaction, and tree-navigation event handlers;
- connect event data and UI notification callbacks to ordinary runtime methods.

No other module calls `pi.registerProvider`, `pi.on`, or any other extension API. AskClaude registers no replacement tool because the feature is removed.

### Provider identity

The provider has:

- ID: `anthropic-agent-sdk`
- display name: `Anthropic Agent SDK`
- API metadata: `anthropic-agent-sdk`
- local endpoint metadata: `claude-code://local`

Every model carries this provider/API/local-URI identity. Runtime ownership checks use provider ID, never `baseUrl`. The local URI exists because Pi's Model contract requires `baseUrl`; it is not treated as an HTTP endpoint.

The package name and existing bridge terminology remain unchanged. Phase 6 replaces the extension-specific configuration filename with the `claudeBridge` namespace in Pi's shared settings; the debug environment variables remain as ephemeral overrides.

### Model catalog

The public catalog is the existing ordered set of stable IDs:

- `claude-fable-5`
- `claude-opus-4-8`
- `claude-opus-4-7`
- `claude-opus-4-6`
- `claude-sonnet-5`
- `claude-sonnet-4-6`
- `claude-haiku-4-5`

The provider reads Pi 0.81.1's canonical Anthropic catalog as an internal metadata source, selects only these IDs, preserves their names, reasoning maps, inputs, costs, context windows, and output limits, and projects each model onto the native provider identity. This is a data dependency only; it creates no user-facing or compatibility relationship with another provider registration.

Pi's canonical `contextWindow` and `maxTokens` values are used unchanged. The bridge no longer maintains account-plan overrides. The final composed model's context window determines the Claude Code model argument: models that require an explicit long-context selection receive `[1m]` when their final context window exceeds 200K; models whose bare ID has the required window remain bare. A `modelOverride` therefore changes both Pi's compaction threshold and, where supported, the SDK request form.

Claude Code's `supportedModels()` is not used to build or filter this catalog. Its initialization response contains aliases such as `default`, `sonnet`, and `haiku`, omits exact context/output/pricing metadata, and cannot be safely intersected with stable full IDs. Human descriptions are not machine-readable policy.

### `models.json`

Users may apply field-level `modelOverrides` to supported IDs. Provider-level custom models, added IDs, changed API values, or changed local endpoint metadata are unsupported.

The Provider applies two defenses:

1. `filterModels` removes models whose ID or provider/API/local-URI identity is not supported.
2. `stream` and `streamSimple` independently validate the selected model and emit a terminal Pi error stream before creating an Agent SDK query.

There is no fallback that sends an unknown ID to Claude Code and guesses a context window.

### Authentication

Claude Code owns authentication. The Provider implements Pi's ambient `ApiKeyAuth` contract because Pi requires every provider to expose API-key or OAuth semantics, but it neither fabricates a key nor stores a credential. It supplies `check` and `resolve` without `login`, returning `{ auth: {}, source: "Claude Code" }` only after a successful first-party account probe.

Account discovery uses a short-lived Agent SDK control Query and its public `accountInfo()` method. The query:

- uses the same configured or SDK-bundled Claude executable as model queries;
- sends no prompt and consumes no model tokens;
- has no tools, no session persistence, no project setting sources, and no background lifetime;
- is closed immediately after initialization;
- validates `apiProvider === "firstParty"`;
- treats the SDK's explicit no-token state as logged out;
- discards account identity fields rather than logging or storing them.

Keeping the control Query open is deliberately rejected: account information is an initialization snapshot, and the query is created before a real request's cwd, system prompt, tools, model, session store, and resume state are known.

`auth.check` performs a fresh availability probe. Concurrent checks share one in-flight Promise. `auth.resolve` reuses the last successful snapshot and probes only when no successful snapshot exists. A logged-out check clears that snapshot. There is no timer, debounce interval, or general mutex.

A logged-out account makes the provider unavailable, as expected for ambient authentication. Probe process failures, malformed responses, and non-first-party backends reject with actionable provider diagnostics. The README instructs users to run `claude auth login`.

Pi dispatches `/login` as a hard-coded interactive command before extension commands, so the extension cannot replace it with `registerCommand("login", ...)`. The ambient `ApiKeyAuth` contract already supplies the appropriate provider-specific behavior: with `check` and `resolve` but no `login`, `/login anthropic-agent-sdk` opens Pi's informational ambient-auth dialog rather than asking for or storing a key. The auth method name identifies Claude Code CLI authentication and includes the `claude auth login` instruction so that dialog is actionable. Supplying a `login` method that only throws is rejected because Pi would present it as an API-key setup and wrap the message as a failed key-save operation.

### Stream boundary

The native Provider implements both required methods:

- `streamSimple(model, context, options)` accepts Pi's normalized reasoning option.
- `stream(model, context, options)` uses the same bridge state machine with base stream options and Claude Code's default effort unless an explicit compatible reasoning field is present.

Both methods validate the model and delegate to the same runtime stream closure. The normal stream continues to map Agent SDK events, tool calls, usage, stop reasons, and errors into Pi's AssistantMessageEventStream contract.

### Bridge runtime boundary

`createBridgeRuntime(dependencies)` owns mutable provider execution state in a closure rather than module globals. It exposes a narrow interface expected to include:

- `stream` for provider requests and tool-result continuations;
- `close(reason)` for session shutdown and provider changes;
- `markRebuild(reason)` for compaction and tree changes;
- a UI notification setter or lifecycle method;
- an explicit test interface for session-sync and MCP-routing assertions.

The runtime owns the shared Claude session, BridgeSessionStore, root and reentrant QueryContexts, active query set, MCP pending-result routing, persistent input queue, and query lifecycle. It receives config, logging, and notification dependencies, not `ExtensionAPI`.

A QueryContext stores the Agent SDK's public `Query` type directly. It does not maintain a bridge-owned subset that can preserve obsolete method signatures. Runtime decisions consume typed control receipts and SDK messages at the boundary, then reduce them into bridge state.

Tool-definition changes are reconciled against the live query with `setMcpServers()`. Model-only changes continue through `setModel()`. The spawn signature retains only options that cannot be applied live; a query rebuild is reserved for changed process-level options, divergent transcript history, unrecoverable control errors, or compromised session storage.

### Nested runtime ownership

The first extension instance in a process owns the Provider/runtime pair. A global registration guard records that pair. Nested Pi runtimes inherit the already-registered native Provider and do not replace its stream closure with a separately evaluated extension module. Reentrant calls and their MCP tool results therefore continue to share the owning runtime's active QueryContext set.

This guard is internal. Other extensions use the provider through Pi's ordinary model runtime and must not inspect or special-case it.

`pi-librarian` demonstrates the downstream boundary. Its `extensions/librarian/model-runtime.ts` creates a fresh ModelRuntime because ExtensionContext exposes only the ModelRegistry compatibility facade, then mirrors legacy provider configs by reference so the bridge's live `streamSimple` closure survives. Pi 0.81.1 provides `ModelRegistry.getRegisteredNativeProvider()`. After this provider cutover, librarian should prefer that getter and call `registerNativeProvider()` with the exact Provider object; this carries the bridge-runtime closure into the nested session without provider-specific knowledge. Its legacy-config fallback can remain for other legacy extensions.

`pi-sessions` has the same class of workaround and requires the same follow-up, but is intentionally not investigated in this design. Both sibling repositories should be updated after this implementation is complete. The native API removes their bridge-specific config/`streamSimple` copying, but not the general need to create a fresh ModelRuntime while ExtensionContext keeps its runtime private.

### Compaction and usage

The isolated compaction stream remains separate from the persistent provider runtime because it is a one-shot, no-tools summary request. It moves into a dedicated compaction module.

A shared SDK-to-Pi usage mapper updates both normal provider outputs and isolated summary outputs. The isolated stream attaches terminal SDK usage to its successful AssistantMessage. Pi's `compact()` then carries that usage into CompactionResult, including the sum of both summary calls for split-turn compaction. Normal provider terminal aggregate usage is not added separately because assistant-turn usage is already persisted; doing so would double count.

Default branch summaries continue through the normal provider stream and already receive assistant usage. No custom branch-summary handler is introduced.

Pi 0.81.1 adds configured retries and retry lifecycle events around its default compaction and branch-summary calls. Branch summaries inherit that behavior automatically. The bridge's `session_before_compact` takeover returns an already-generated CompactionResult, so Pi cannot wrap its isolated summary call. The isolated compaction module must therefore use 0.81.1's `retryAssistantCall` with Pi's effective retry policy and retain usage only from the successful attempt. ExtensionContext does not expose that policy or let an extension emit Pi's summarization retry lifecycle events; implementation must verify whether the public SettingsManager can reproduce the effective persisted policy without diverging from in-memory SDK settings. If it cannot, preserving the takeover means documenting that custom compaction cannot provide Pi's lifecycle events until Pi exposes the missing extension boundary.

### Agent SDK 0.3 runtime signals

Agent SDK 0.3.218 bundles Claude Code 2.1.218 and exposes several contracts that replace bridge-owned inference:

- Successful results report `canonicalModel` and `provider` for each `modelUsage` entry. The usage mapper attributes each served model's tokens and reference cost to that model, including fallback turns, while preserving Pi's requested model as the assistant message identity. If Pi's Usage shape cannot represent a multi-model turn, the mapper sums SDK-provided `costUSD` and records the per-model breakdown in diagnostics rather than pricing every token at the requested model's rate.
- `Query.setMcpServers()` updates the live process's MCP surface. The runtime diffs normalized server definitions, applies additions/removals through the control channel, verifies the response, and rebuilds only if reconciliation fails. `initializationResult()` is used to inspect initial MCP status; required bridge-owned SDK servers may not remain `pending` when the first model turn starts. `reconnectMcpServer()` is reserved for an explicitly failed existing server, not used as a general retry loop.
- `Query.interrupt()` returns a typed receipt containing `still_queued`, and interrupted assistant messages carry `aborted: true`. An empty receipt permits reuse once the terminal result arrives. Remaining queued commands, a missing terminal result, or a control error make the process non-reusable and trigger the existing bounded hard-close path. The bridge does not retain a `Promise<void>` compatibility contract.
- Rate-limit events and result errors distinguish API 429 from overload 529 and expose limit type, utilization, reset windows, model-scoped weekly limits, and credit eligibility. The provider converts stable structured fields into Pi warnings and terminal errors; human message text is preserved only as detail. Experimental usage APIs remain diagnostic until Anthropic removes their instability warning.
- Command lifecycle and structured `terminal_reason` events identify queued, started, completed, cancelled, and discarded inputs. The persistent input queue uses these events to confirm steering/follow-up disposition and to detect dead turns rather than inferring command fate from whichever result arrives first.

### SessionStore contract

The alpha `SessionStore` API did not materially change between Agent SDK 0.2.141 and 0.3.218. `SessionKey`, `SessionStoreEntry`, `SessionStoreFlush`, `SessionSummaryEntry`, and the append/load/list/delete/subkey contracts are unchanged; 0.3 only clarifies that `listSessions().mtime` is an integer Unix-millisecond value. The dependency bump therefore requires no storage migration.

The bridge already relies on the important parts of the contract: UUID-idempotent append, subkey separation, revision fencing for stale writers, atomic transcript replacement, batched mirroring, resume through `load()`, and `mirror_error` observation. Batched mode exposes no public `flush()` method. Instead, the SDK awaits its pending `SessionStore.append()` batch before yielding each `result`, and flushes again before iterator EOF and on its read-error path. Those barriers already existed in 0.2.141; they are not new in 0.3.218. A consumed `result` is therefore the turn-level durability barrier for mirror frames received before that result, while awaited natural iterator EOF is the process-level barrier for later frames. `Query.close()` remains synchronous and forceful, so it is not a durability barrier for transcript frames the subprocess has not emitted.

Phase 7 hardens this lifecycle rather than inventing a separate writer flush. Query options set `sessionStoreFlush: "batched"` and a finite `loadTimeoutMs` explicitly. Graceful replacement ends streaming input and awaits query completion before closing the bridge writer or loading the same session; hard close invalidates the writer revision and rebuilds from Pi history because no flush guarantee is possible. A `mirror_error` is a data-integrity failure because the in-memory store is authoritative for later rebuilds: the runtime reports a terminal provider error, invalidates that stored session, closes the query, and rebuilds from Pi's complete message history on the next call. A load timeout or malformed transcript fails before process startup and follows the same rebuild path. Eager flushing is rejected because it multiplies calls without strengthening the result/EOF barriers. Session summaries and listing APIs are not implemented until the bridge exposes a user-facing session browser; maintaining unused indexes would be ceremony.

## Design Decisions

### 1. Remove AskClaude without compatibility support

Delete the tool registration, query/session implementation, action-summary renderer, `askclaude-ui.ts`, configuration schema and merge behavior, README and TODO guidance, fixtures or test cases dedicated to it, and its Pi TUI dependency when no longer imported. An `askClaude` key in either configuration file becomes an unknown-property validation error. Historical changelog entries remain untouched.

This is a product deletion, not a deprecation. No disabled stub, renamed setting, warning shim, or resumed-tool compatibility path remains.

### 2. Prefactor before provider cutover

AskClaude removal is paired with a targeted structural refactor:

- `index.ts`: extension entrypoint and complete Pi registration surface;
- `bridge-runtime.ts`: persistent query/session/MCP state machine;
- `provider-stream.ts`: Agent SDK event-to-Pi stream conversion and usage mapping, renamed from the current `provider.ts`;
- `compaction.ts`: isolated summary and compaction file-operation support;
- `debug.ts`: bridge logging, diagnostic dumps, child environment, and per-query CLI debug options.

Existing small pure helpers remain flat. The project does not gain a deep directory hierarchy merely to look organized.

### 3. Convert executable tests to TypeScript

Rename the Node test and RPC harness files under `tests/` from `.mjs` to `.ts`, update local imports to the project's `.js` TypeScript specifier convention, and update the package-script globs and README. Small process-level integration drivers remain shell scripts. Convert `usage-test.sh` to TypeScript as part of the same phase: its subprocess orchestration, HTTP/JSON handling, metrics, and arithmetic no longer benefit from shell.

The `.mjs` shape is historical: the tests existed as JavaScript before the source modules were converted to TypeScript, and `tsx` was introduced so those JavaScript tests could import TypeScript source. The current runner already uses `node --import tsx`, so TypeScript tests require no new runtime. Converting them brings test helpers, fixtures, mocked contracts, and assertions under the existing `tsc --noEmit` check instead of maintaining an untyped second codebase. ShellCheck covers the shell scripts that remain.

### 4. Use a hand-written native Provider

A focused provider factory owns provider identity, ambient auth, model construction, filtering, and both stream methods. It receives injected stream and account-probe dependencies. It does not receive `ExtensionAPI`.

`createProvider()` is not used because its persisted dynamic-overlay behavior targets remote catalogs. This provider has a static canonical catalog and local account availability; explicit code better represents those rules.

### 5. Use Pi's catalog, not account-derived model metadata

Pi 0.81.1's canonical model records are the model metadata source. The bridge's former `provider.plan`, `provider.longContextExtraUsage`, LongContextSettings, display-name rewriting, and context-window override layer are removed.

AccountInfo is used only for authentication/backend availability. It is not used to infer model limits. Usage-credit authorization remains Claude Code's responsibility: a rejected request surfaces normally, and a metered request is not predicted by this extension.

### 6. Keep stable IDs and a closed catalog

Mutable SDK aliases are unsuitable as persisted Pi model IDs. Only explicitly supported full IDs are exposed. Unknown IDs fail fast; the former unknown-ID 200K fallback is deleted.

### 7. Keep login outside Pi

Pi does not mint, import, refresh, or store Claude Code credentials. Ambient auth is represented through the native provider contract without fake values. This keeps one credential owner and one login workflow. Pi's built-in ambient-auth dialog provides the instruction boundary; the extension neither overrides `/login` nor implements a deliberately failing pseudo-login.

### 8. Preserve one runtime owner for reentrant nested calls

Native registration changes the Provider abstraction but not the MCP causality: tool results must reach the QueryContext that owns their tool-use IDs. Fresh downstream ModelRuntimes must register the same native Provider object by reference, preserving its owning bridge-runtime closure. A separately evaluated nested extension instance must not replace that closure.

### 9. No compatibility overlap

The provider cutover has no feature flag, alias, wrapper provider, or dual stream path. Existing provider/session configuration is not migrated. Pi's own behavior for unavailable stored selections applies without extension-specific detection.

### 10. Prefer SDK control and lifecycle contracts over reconstruction

When the Agent SDK exposes served-model identity, MCP reconciliation, interrupt receipts, command lifecycle, structured rate limits, or storage failures, the bridge consumes that public contract directly. It does not preserve old local interfaces, parse prose, or rebuild a query merely because an older SDK lacked a control method. Experimental APIs may inform diagnostics but do not become correctness dependencies.

### 11. Put bridge settings under one shared Pi namespace

Global `~/.pi/agent/settings.json` holds one `claudeBridge` object with `provider` and `debug` children. The bridge reads only `SettingsManager.getGlobalSettings()`, matching sibling extensions such as `pi-librarian`; project settings are outside this extension's configuration boundary. Root validation permits sibling Pi and extension keys, while every object below `claudeBridge` rejects unknown keys. Defaults are normalized once before downstream consumers receive the settings.

`debug.enabled` defaults to false and `debug.logPath` defaults to `~/.pi/agent/claude-bridge.log`. `CLAUDE_BRIDGE_DEBUG=1` or `0` overrides the global enabled value, and a nonempty `CLAUDE_BRIDGE_DEBUG_PATH` overrides the global log path; a path alone does not enable logging. Environment overrides remain because ephemeral diagnostics and the process-level test harness should not require settings rewrites.

Dedicated `claude-bridge.json` files are outside the settings boundary and are never inspected. There is no read, detection, warning, or migration path.

## Edge Cases & Failure Modes

- **Claude Code logged out:** `auth.check` returns unavailable, clears its successful snapshot, and the provider contributes no available models.
- **Account probe cannot initialize:** reject with an actionable provider error; do not assume authentication.
- **Account uses a non-first-party backend:** reject as unsupported because this provider's catalog and usage semantics are first-party-specific.
- **Two auth checks overlap:** share the same in-flight control Query; no duplicate process and no lock queue.
- **A provider request occurs before any availability check:** `auth.resolve` performs the initial probe.
- **Claude login changes during a running session:** a later Pi availability check refreshes the snapshot. Existing model queries remain authoritative for request-time authentication errors.
- **Unknown model is added through `models.json`:** omit it from availability; if directly selected, emit a terminal error stream before SDK startup.
- **Supported ID has changed API or local URI metadata:** treat it as unsupported rather than coercing it.
- **Supported model has a field override:** preserve the override; use the final context window to choose the Claude Code long-context request form.
- **Long-context authorization is absent:** preserve Claude Code's error verbatim so Pi can display or classify it; do not silently reduce the advertised window.
- **Main query terminal result contains cumulative usage:** do not attach the cumulative total again; per-assistant usage remains the session accounting source.
- **Isolated summary succeeds:** map terminal usage onto the summary AssistantMessage so compaction persists it.
- **Isolated summary fails or aborts before terminal usage:** do not invent partial usage.
- **Nested provider call occurs while the root query is active:** create a reentrant QueryContext in the owning runtime and match MCP results by native tool-use ID.
- **Nested extension module loads:** do not replace the inherited provider/runtime closure.
- **Extension reload:** the owning runtime closes cleanly and releases the global ownership guard before the new extension instance registers.
- **`claudeBridge` still contains `askClaude`, `provider.plan`, or `provider.longContextExtraUsage`:** ignore them; unknown keys under `claudeBridge` are tolerated and unused, and sibling keys in the shared Pi settings file are never inspected.
- **Claude Code serves a fallback model:** retain the requested Pi model identity, but calculate cost from each canonical served-model usage entry and record the fallback.
- **Live MCP reconciliation reports an error or leaves a required server pending:** do not send a model turn against a partial tool surface; close and rebuild once, then fail visibly if initialization is still incomplete.
- **Interrupt receipt contains queued commands:** do not mark the query ready for input; drain or hard-close it so cancelled steering cannot execute in a later turn.
- **Rate-limit event is a warning:** notify with structured utilization and reset data while leaving the turn alive. A rejected limit becomes a terminal provider error.
- **SessionStore emits `mirror_error`:** invalidate the session and rebuild from Pi history on the next request; never resume from the incomplete transcript.
- **SessionStore load times out or returns malformed entries:** fail before spawning Claude Code and rebuild from validated Pi history rather than retrying the same store materialization indefinitely.

## Alternatives

### Keep legacy provider-config registration

- **Status:** Rejected
- **Decision:** Pi 0.81.1 has the correct first-class abstraction, and this repository is a provider implementation rather than endpoint configuration.
- **Discussion:** Keeping the legacy form preserves fake auth and adapter-owned behavior without providing a user benefit.

### Continue replacing another provider identity

- **Status:** Rejected
- **Decision:** The Agent SDK provider must coexist under its own explicit identity and must not contain compatibility behavior for a separate provider.
- **Discussion:** A distinct ID makes authentication, billing semantics, and runtime ownership visible instead of overloading one name with two transports.

### Build the catalog from `supportedModels()`

- **Status:** Rejected
- **Decision:** The SDK exposes mutable aliases and descriptions without required pricing, context, max-output, or stable concrete model identity.
- **Discussion:** Exact intersection with Pi's full IDs hides valid models; description parsing is not a contract.

### Probe each model for served metadata

- **Status:** Rejected
- **Decision:** Model discovery must not consume quota or usage credits.
- **Discussion:** Terminal `modelUsage` remains valuable diagnostic evidence after real requests, not a startup catalog protocol.

### Infer model metadata from subscription type

- **Status:** Rejected
- **Decision:** Pi's canonical metadata is authoritative, so the bridge does not maintain a second entitlement table.
- **Discussion:** This removes plan configuration and measured exceptions while leaving authorization to Claude Code.

### Pi-owned login wrapper or `/login` override

- **Status:** Rejected
- **Decision:** Wrapping `claude auth login` would combine an interactive subprocess with a fake Pi credential solely to satisfy storage semantics. Extension commands also cannot override Pi's hard-coded `/login` dispatch.
- **Discussion:** The ambient `ApiKeyAuth` path gives `/login anthropic-agent-sdk` a non-storing informational dialog. A `login()` implementation that only throws would mislabel the flow as API-key setup and produce a worse error. The auth method name and README direct users to the actual credential owner.

### Keep the auth control Query alive

- **Status:** Rejected
- **Decision:** AccountInfo is an initialization snapshot and the query cannot be retrofitted with real provider request options.
- **Discussion:** A persistent auth-only process would be stale resource retention, not caching.

### Preserve AskClaude as disabled code

- **Status:** Rejected
- **Decision:** The feature is unwanted and has meaningful maintenance cost. Removal is intentionally breaking and complete.

### Keep Node tests as `.mjs`

- **Status:** Rejected
- **Decision:** The existing `tsx` runner can execute TypeScript directly, and untyped tests now conceal contract drift in the most stateful parts of the bridge.
- **Discussion:** Small shell integration drivers remain appropriate because they test command-level behavior. The Node tests, shared RPC harness, and logic-heavy usage diagnostic benefit from the same compiler as production code.

### Independent Provider object per nested ModelRuntime

- **Status:** Rejected
- **Decision:** Nested Agent SDK calls must preserve the owning Provider object's bridge-runtime closure so MCP tool results return to the correct active QueryContext.
- **Discussion:** `pi-librarian` currently preserves the legacy `streamSimple` closure by copying ProviderConfigInput by reference. Pi 0.81.1's native equivalent is to retrieve the registered Provider through `getRegisteredNativeProvider()` and register that same object in the fresh ModelRuntime. `pi-librarian` and `pi-sessions` require follow-up changes after this repository lands.

## Implementation Plan

- [x] Phase 1: Remove AskClaude and expose runtime boundaries
  - Goal: Delete the unwanted feature and make the extension registration surface and provider runtime independently understandable without changing provider behavior.
  - Files: `src/index.ts`, delete `src/askclaude-ui.ts`, add `src/bridge-runtime.ts`, `src/compaction.ts`, `src/debug.ts`, rename `src/provider.ts` to `src/provider-stream.ts`, config/tests/README/TODO/package metadata.
  - Work: Remove every AskClaude path and setting; remove unused Pi TUI dependency; move all `ExtensionAPI` calls and event registration into the thin entrypoint; create a factory-owned bridge runtime; extract compaction/debug concerns; preserve legacy provider registration temporarily; update tests without changing provider identity or stream semantics.
  - Validation: `npm run typecheck`; full unit suite; current provider smoke, multi-turn, cache, session, compaction, cancellation, and nested-ModelRuntime regressions; repository search finds no current AskClaude references outside historical CHANGELOG and intentionally untouched external artifacts.

- [x] Phase 2: Convert the Node test suite to TypeScript
  - Goal: Put executable test helpers and fixtures under the same compiler as production code, preserving the unit/integration suites while hardening the one-off usage diagnostic's error handling.
  - Files: renamed `tests/**/*.mjs` and `tests/usage-test.sh` to `.ts`, `tsconfig.json`, local test imports, `package.json`, README, CHANGELOG.
  - Work: Renamed all Node unit/integration tests, the RPC harness, and the usage diagnostic; used `.js` specifiers for local TypeScript imports; enabled `noImplicitAny` so every migrated helper and assertion earns a real contract; replaced the RPC harness's open `any` index signature and generic casts with a parsed finite envelope and explicit command-result parsers, including a shared `CompactionResult` contract; used the canonical `cc-session-io` block types with narrowing helpers in the converter test instead of an invented wire model; added an explicit collection type to the one `convert.ts` inference the stricter flag surfaced (no runtime change). Replaced the usage diagnostic's shell/Python/eval data plumbing with typed subprocess, HTTP, JSON, and metrics code that conforms untrusted subprocess JSON, validates the turns argument, runs Pi in its own process group (so a hung run's Claude Code child cannot leak), preserves per-turn direct-turn evidence logs, and fails on a failed direct turn rather than emitting a misleading zero-usage row. Left the small `.sh` process tests unchanged; ShellCheck now covers only the remaining shell drivers and its usage-metric `SC2153` suppression is gone.
  - Validation: `npm run typecheck` (now `noImplicitAny`) clean; all 118 pre-migration unit tests remain discovered, with the current 124-test suite adding runtime and RPC-boundary coverage; the `tests/int-*.ts` glob matches the same 14 Node integration files (21 tests) as the prior `.mjs` glob; the full integration and usage suites run outside the sandbox against authenticated local settings.

- [x] Phase 3: Adopt Pi 0.81.1 accounting, retries, and native types
  - Goal: Establish the dependency and accounting foundation before changing provider identity.
  - Files: `package.json`, lockfile, `provider-stream.ts`, `compaction.ts`, `sdk-usage.ts`, model and compaction tests, CHANGELOG.
  - Work: Raised both Pi peer floors to 0.81.1 (development packages were already aligned); extracted one SDK-to-Pi usage and cost mapper using Pi's native `Usage.reasoning`; retained stream-event accounting for normal provider turns without applying terminal cumulative result usage; applied terminal Agent SDK usage to successful isolated summaries so Pi's compaction code persists and combines baseline or split-turn usage. Custom compaction resolves provider configuration from global Pi settings, while Pi's merged global/project retry policy and the isolated Claude process resolve from the event context's project directory. Required dependencies are wired at the extension composition root. This preserves transient-error classification, retry count, backoff, and successful-attempt-only accounting. ExtensionContext exposes neither the live SettingsManager nor lifecycle event emission, so in-memory-only SDK overrides and Pi's summarization retry lifecycle events remain unavailable to the takeover; persisted interactive settings are reloaded for each compaction.
  - Validation: `npm run typecheck` and the 128-test unit suite pass; a synthetic transient summary failure performs one configured retry and records only the successful result usage; RPC compaction parsing and authenticated baseline/split-turn integration assertions require nonzero usage; both authenticated smokes pass against local Claude Code auth, with baseline persisting 14,600 summary tokens and split-turn exercising both summary calls.

- [x] Phase 4: Introduce and cut over to the native Provider
  - Goal: Replace legacy provider-config registration with one complete `anthropic-agent-sdk` Provider and delete the old abstraction in the same stable change.
  - Files: added `provider.ts` and `account-probe.ts`; updated model/config/runtime/ownership/compaction/entrypoint modules, native-provider unit and integration coverage, README, and CHANGELOG.
  - Work: Registered one hand-written Pi 0.81.1 Provider with ambient Claude Code authentication, canonical seven-model metadata, strict identity filtering, raw and normalized stream methods, and terminal pre-query model rejection. Account checks use a closed, no-prompt Agent SDK control Query with shared in-flight checks and a successful snapshot for resolve. Final composed context windows now choose bare or `[1m]` Claude Code IDs; plan/Extra Usage policy, fake credentials, legacy transport markers, display/context rewriting, and unknown-ID fallback are gone. Process ownership stores and re-registers the complete Provider/runtime pair by reference, and nested ModelRuntimes mirror that native Provider object.
  - Validation: Typecheck and 128 unit tests pass, covering provider/auth/probe/model/override/filter/stream contracts. Authenticated smoke, multi-turn, cache, and all 21 Node integration tests pass with `anthropic-agent-sdk`; model listing shows exactly seven models, explicit model/provider requests succeed, a `models.json` context override is reflected while an added ID stays hidden, and direct selection of that ID emits the terminal provider error while the executable trace contains only auth control invocations and no `--model` Claude process.

- [x] Phase 5: Prove native behavior at system seams
  - Goal: Demonstrate that the first-class provider is transparent to Pi sessions and identify downstream migration work without coupling this repository to sibling extensions.
  - Files: integration tests, README, TODO, CHANGELOG, and this design; no production defect required a source change.
  - Work: Drove Pi 0.81.1 in a real PTY with an isolated agent directory through the seven-model `/model` picker, ambient `/login anthropic-agent-sdk` guidance, a bridged read-tool round trip, switching to Google and back, extension reload with preserved context, Esc cancellation during streamed output with a subsequent completed turn, manual compaction, default branch summarization with continued execution, persisted `--continue` resume, and `/new`. Tightened the provider-switch integration regression to require the old persistent query to close and the returning provider to rebuild history before spawning. Existing authenticated integrations exercise persistent cache behavior, new-session clearing, compaction variants, cancellation and abort recovery, reentrant tool routing, and foreground/background nested ModelRuntimes; injected unit tests cover logged-out, malformed, failed, and non-first-party account probes without altering local Claude auth. Updated README guidance for ambient login and API-equivalent reference cost, and recorded `pi-librarian` and `pi-sessions` Provider-object propagation in TODO.
  - Validation: `npm test` passes outside the sandbox with authenticated local settings: 128 unit tests, 5/5 provider smoke cases, 5/5 multi-turn/tool cases, cache coverage with one stable session and no rebuild, and all 21 Node integration tests including the nested-ModelRuntime regression. `npm run typecheck` passes. Retained Terminal Control evidence under `.test-output/phase5-termctrl/` covers `/model`, print mode, tool execution, provider switching, reload, Esc cancellation, `/compact`, branch summary, persisted resume, `/new`, and ambient login guidance. The real logged-out path was not exercised because doing so would disturb Claude-owned auth; its false/error behavior remains fixture-covered. Pi's pre-stream auth ordering and provider-composer's synthetic API-key login on an overlaid native provider were confirmed against the exact 0.81.1 host source and deliberately not patched.

- [x] Phase 6: Move bridge configuration into Pi settings
  - Goal: Replace dedicated bridge configuration with extension configuration in Pi's global shared settings file.
  - Files: renamed `src/config.ts` to `src/settings.ts`; updated entrypoint, debug, account-probe, runtime, and compaction wiring; settings unit and process integrations; README, CHANGELOG, package test script, and this design.
  - Work: Put the complete surface under `claudeBridge` in Pi's global `settings.json`, tolerating unknown keys; read only the global scope through Pi 0.81.1's `SettingsManager`; ignore project settings and dedicated `claude-bridge.json` files without inspecting them; normalize defaults into one resolved downstream settings type. Add `debug.enabled` and `debug.logPath`; keep `CLAUDE_BRIDGE_DEBUG=1|0` and nonempty `CLAUDE_BRIDGE_DEBUG_PATH` as higher-precedence process overrides. Provider settings used by isolated compaction remain global, while Pi's independent retry policy retains its existing trusted global/project resolution.
  - Validation: `npm run typecheck` and `npm run lint` pass, including ShellCheck for the revised process driver. All 131 unit tests pass, covering global shared-file parsing, sibling-key tolerance, unknown-key tolerance, normalized defaults, project-setting isolation, prompt invariants, debug environment precedence, malformed global Pi settings, and inert dedicated files. The authenticated `tests/int-settings.sh` smoke passes with both debug environment variables unset; `.test-output/phase6-settings-spawns.log` proves the configured global executable ran, and `.test-output/phase6-settings-debug.log` proves settings-only logging.

- [ ] Phase 7: Adopt Agent SDK 0.3 runtime control and integrity signals
  - Goal: Replace remaining bridge inference with Agent SDK contracts for served-model accounting, live MCP changes, cancellation, quota reporting, command disposition, and transcript integrity.
  - Files: `bridge-runtime.ts`, `provider-stream.ts`, `query-state.ts`, `session-store.ts`, focused unit/integration tests, README diagnostics, CHANGELOG.
  - Work: Store the SDK `Query` type directly; account from canonical per-model usage and preserve fallback diagnostics; reconcile changing SDK MCP servers with `setMcpServers()` and verify required initial status with `initializationResult()`; consume interrupt receipts, aborted assistant metadata, command lifecycle, and terminal reasons to determine query reuse; map stable structured rate-limit fields into Pi notifications/errors; explicitly configure batched SessionStore flushing and load timeout; preserve `result` as the turn-level mirror barrier and awaited natural EOF as the replacement barrier; turn forced close, `mirror_error`, or invalid resume materialization into session invalidation and a rebuild from Pi history. Do not depend on the experimental usage method or implement unused session-list summary indexes.
  - Validation: Unit tests cover multi-model fallback accounting, MCP add/remove/reconcile failure, empty and nonempty interrupt receipts, command cancellation/discard, 429/529 and model-scoped quota messages, result-before-append prevention, natural-EOF final flushing, forced-close revision fencing, mirror failure invalidation, and load timeout. Authenticated integration tests prove a changed Pi tool set does not rotate the Claude process, an interrupted queued follow-up cannot leak into the next turn, fallback usage is priced from the served model, option drift cannot load a session before the prior query's final mirror flush, and a deliberately failing SessionStore rebuilds from Pi history without writing or resuming a partial transcript.
