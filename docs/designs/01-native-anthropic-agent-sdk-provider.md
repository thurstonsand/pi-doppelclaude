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

## Goals

- Register a complete Pi 0.81.1 Provider under the stable provider ID `anthropic-agent-sdk`.
- Keep the extension's entire Pi registration and event surface visible in `src/index.ts`; do not pass `ExtensionAPI` outside that module.
- Remove AskClaude completely, including settings and compatibility handling.
- Make Pi's canonical catalog authoritative for supported model metadata while retaining an explicit, ordered allowlist of stable full model IDs.
- Represent Claude Code authentication truthfully as ambient, first-party authentication owned outside Pi.
- Preserve the persistent query, session synchronization, MCP tool bridge, reentrant call, cancellation, and compaction behavior already established by integration tests.
- Include nested Agent SDK and isolated-compaction usage in the appropriate Pi session entries without double counting normal provider turns.
- Fail fast on unsupported model identity or transport metadata.

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

The package name, extension configuration filename, debug environment variables, and existing bridge terminology remain unchanged unless separately designed.

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
- **Configuration still contains `askClaude`, `provider.plan`, or `provider.longContextExtraUsage`:** fail strict validation; no compatibility message or fallback default.

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

- [ ] Phase 2: Convert the Node test suite to TypeScript
  - Goal: Put executable test helpers and fixtures under the same compiler as production code without changing test behavior.
  - Files: rename `tests/**/*.mjs` and `tests/usage-test.sh` to `.ts`, local test imports, `package.json`, README, CHANGELOG.
  - Work: Rename all Node unit/integration tests, the RPC harness, and the usage diagnostic; use `.js` specifiers for local TypeScript imports; replace the usage diagnostic's shell/Python/eval data plumbing with typed subprocess, HTTP, JSON, and metrics code; update runner globs and documentation; add explicit fixture types where the compiler reveals ambiguous contracts; leave the small `.sh` process tests unchanged.
  - Validation: `npm run typecheck`; `npm run test:unit`; compare the discovered unit and integration test counts before and after renaming; run the full integration suite outside the sandbox to prove the glob migration did not omit tests.

- [ ] Phase 3: Adopt Pi 0.81.1 accounting, retries, and native types
  - Goal: Establish the dependency and accounting foundation before changing provider identity.
  - Files: `package.json`, lockfile, `provider-stream.ts`, `compaction.ts`, model and compaction tests, CHANGELOG.
  - Work: Raise Pi dev and peer floors to 0.81.1; remove obsolete type casts made unnecessary by aligned packages; extract one SDK-to-Pi usage mapper; attach terminal summary usage to isolated compaction outputs; retain normal per-turn accounting without terminal double counting; preserve 0.81.1 transient-summary retries in the custom compaction path using the closest public representation of Pi's effective retry policy, recording any unavoidable lifecycle-event limitation.
  - Validation: Typecheck and unit suite; authenticated compact baseline and split-turn smoke show nonzero persisted compaction usage; a synthetic transient summary failure retries according to policy and records usage only once; normal provider session totals remain unchanged for equivalent turns.

- [ ] Phase 4: Introduce and cut over to the native Provider
  - Goal: Replace legacy provider-config registration with one complete `anthropic-agent-sdk` Provider and delete the old abstraction in the same stable change.
  - Files: add focused provider factory/account-probe module, `models.ts`, `index.ts`, `bridge-runtime.ts`, conversion tests, provider tests, config, package/README/CHANGELOG.
  - Work: Build complete models from Pi metadata; implement ambient first-party account probing through SDK AccountInfo; implement native auth, filtering, raw/simple streams, model validation, and semantic local metadata; switch registration and ownership checks to provider ID; remove fake key, legacy base/API markers, partial model projection, plan/extra-usage settings, unknown-model fallback, the loose-function registration guard, and all compatibility paths; replace that guard with ownership of the complete Provider/runtime pair so inherited or explicitly mirrored native registrations preserve the same stream closure.
  - Validation: Unit tests for provider shape, auth states, account-probe concurrency, model projection, overrides, invalid additions, both stream methods, and terminal error shape; `--list-models`, explicit `--model`, and `--provider` smoke tests use `anthropic-agent-sdk`; `models.json` override and invalid-addition integration tests; full existing integration suite with the new ID; verify no Claude process starts for a rejected model.

- [ ] Phase 5: Prove native behavior at system seams
  - Goal: Demonstrate that the first-class provider is transparent to Pi sessions and identify downstream migration work without coupling this repository to sibling extensions.
  - Files: integration tests and final README/design updates only unless defects are found.
  - Work: Exercise extension reload, model switching away/back, new/resumed sessions, persistent cache behavior, cancellation, compaction, branch summary, nested ModelRuntimes, reentrant tool calls, first-party auth absence/failure, and `/login anthropic-agent-sdk`; document Claude-owned login, API-equivalent cost, canonical model metadata, modelOverride support, and unsupported model additions; record follow-up tasks for `pi-librarian` and `pi-sessions` to pass the registered native Provider object into their fresh ModelRuntimes after this implementation lands.
  - Validation: Full `npm test` outside the sandbox with authenticated local settings; direct real-world smoke for `/model`, print mode, a tool round trip, `/compact`, provider switching, ambient login guidance, and the provider-agnostic nested-ModelRuntime regression. Downstream sibling fixes are deliberately not part of this repository's implementation.

- [ ] Phase 6: Move bridge configuration into Pi settings
  - Goal: Replace the dedicated `claude-bridge.json` files with extension configuration in Pi's shared settings files.
  - Work: Design the shared-settings shape and global/project precedence; move debug enablement into settings; decide whether `CLAUDE_BRIDGE_DEBUG` remains as a supported override and, if so, define its precedence.
  - Validation: To be designed when this phase begins.
