# Changelog

## UNRELEASED

- **Remove: AskClaude delegation tool** — delete the AskClaude tool, its one-shot/isolated query and session behavior, `askClaude` config schema/defaults/merge handling, status-line UI, and dedicated test coverage, and drop the now-unused Pi TUI peer dependency. Removed `askClaude` settings now fail fast as unknown config properties.
- **Refactor: split the extension into focused runtime modules** — `index.ts` is now the sole holder of the `ExtensionAPI` and builds a factory bridge runtime with ordinary dependencies, so no query/session state lives in module globals. `bridge-runtime.ts` owns the persistent query/session/MCP state machine and its root query context, `compaction.ts` owns isolated compaction summaries and file-op reinjection, `debug.ts` owns bridge logging/diagnostics/child environment/SDK debug options, `sdk-result.ts` holds the shared Agent SDK result-error and served-window helpers, and `provider.ts` is renamed to `provider-stream.ts`. Bridge logs and global config resolve through Pi's `getAgentDir()`. Provider identity, stream semantics, and debug log anchors are unchanged.
- **Refactor: process-scoped bridge owner** — replace the `ACTIVE_STREAM_SIMPLE_KEY` loose-function registration guard with a single process-owned bridge runtime held in a private `Symbol.for()` registry (`bridge-owner.ts`). Every activation registers that runtime's identical stream closure into its own Pi runtime, so nested/reentrant MCP routing is preserved; a nested (subagent) activation borrows the shared runtime instead of building an unused second one. Only the activation that created the owner runs the session/UI/model-select/rebuild lifecycle mutations or clears the owner on shutdown, so a borrower never clears the parent session, overwrites its UI, marks its root for rebuild, or closes it on model selection. Compaction still runs per activation.
- **Refactor: move transcript persistence behind the Agent SDK** — use the alpha `sessionStore` adapter as the authoritative in-memory transcript and remove bridge-owned `~/.claude/projects` writes, path hashing, filesystem verification diagnostics, and post-abort session ID rotation. Completed persistent queries drain to natural EOF before their store writer closes, per-query revisions fence hard-killed writers, and one UUID survives rebuilds and abort recovery; SDK mirror failures are recorded in the debug log.
- **Refactor: keep provider queries alive across turns** — move every provider request to Agent SDK streaming input mode, push follow-up turns and steering into one persistent Claude Code process, use live model switching when only the model changes, and close or rebuild the process when session history or query options drift. Replacement queries now wait for the prior transcript writer to exit before resuming or rebuilding its session; abort prefers the SDK's graceful interrupt before falling back to a hard close.
- **Fix: surface Agent SDK and MCP bridge failures** — propagate in-band Claude Code result errors to pi, match parallel MCP calls by their native `tool_use_id`, and fail the provider immediately if Claude Code omits the required MCP metadata. Shell integration tests now use a portable macOS-compatible timeout helper.
- **Tests: isolate integration configuration** — seed a valid bridge prompt mode in test-only Pi agent directories and merge per-test Pi settings into the sandbox so local configuration cannot create false passes or startup timeouts.
- **Tests: make nested-runtime coverage self-contained** — replace the external-checkout regression with a provider-agnostic fixture tool that creates a nested `ModelRuntime`, propagates registered providers by reference, and proves foreground and background reentrant completion. Add a mise bootstrap with pinned ShellCheck and an hk lint hook, fixing current shell warnings while narrowly suppressing the dynamic usage-metric exports scheduled for TypeScript migration.
- **Add: automated dependency updates** — configure Renovate for npm, GitHub Actions, and mise dependencies, including a regex manager that updates the versioned `hk.pkl` package reference alongside hk releases.
- **Refactor: align query options with the Agent SDK contract** — explicitly authorize bypass permissions, use typed strict MCP isolation everywhere, derive setting sources from the system prompt mode, identify bridge requests in the SDK User-Agent, and remove the obsolete pi-ai stream compatibility shim.
- **Remove: fringe bridge configuration overrides** — remove the unsupported `provider.strictMcpConfig` and `provider.settingSources` overrides.
- **Add: configurable Pi prompt modes and replacement prose** — `provider.systemPromptMode` now distinguishes Claude Code only, rewritten Pi only, and Claude Code with the rewritten Pi prompt appended. Modes that include Pi require custom documentation heading and instructions, and every query path applies the same replacements. Existing `"replace"` configs must use `"pi"`; the default `"append"` mode now requires replacements. Remove the redundant `appendSystemPrompt` and `appendSkills` settings; TypeBox validation rejects malformed or unknown bridge settings at startup.
- **Add: API-equivalent cost reporting** — unconditionally preserve Anthropic catalog pricing so Pi's footer and cache-miss notices show reference prices for subscription-backed usage; no setting is required.
- **Refactor: use Pi's public Anthropic model catalog** — replace the compatibility catalog import and local Sonnet thinking-level fallbacks with Pi 0.80.10's native per-model mappings. Provider calls use the native effort resolution, including `max`.
- **Bump: Pi 0.80.10** — update Pi development and peer dependency floors to the version supplying the canonical model metadata.
- **Tests: use the fork's Anthropic provider ID** — update stale thinking-block fixtures and integration model selectors left behind when the fork replaced the `claude-bridge` provider ID.

## 0.6.2 — 2026-07-06

- **Fix: Sonnet 5 and Fable 5 with 1M context** — bare model IDs (`claude-sonnet-5`, `claude-fable-5`) are 200K context. Must pass `[1m]` suffix for both, similar to Opus 4.8.
- **Fix: xhigh thinking level hidden for Sonnet 5 and Sonnet 4.6 (issue #32)** — pi-ai ships no `thinkingLevelMap` for these models, and pi's `getSupportedThinkingLevels` requires an explicit mapping to show `xhigh` in the picker. This is a workaround for https://github.com/earendil-works/pi/issues/6371

## 0.6.1 — 2026-07-01

- **Add: claude-fable-5 and claude-sonnet-5 models** — Anthropic's Claude Fable 5 (released 2026-06-09) and Sonnet 5 (released 2026-06-30) are now selectable via `/model`. Both force adaptive thinking. The `fable` and `sonnet` shortcuts resolve to these new models.
- **Bump: pi-ai >=0.80.3** — required for claude-fable-5 and claude-sonnet-5 model catalog entries.

## 0.6.0 — 2026-06-29

- **Fix: `/compact` hang (issue #18)** — the bridge now owns compaction for claude-bridge models, running split-turn summaries as isolated Claude Code subprocesses instead of routing them through the live provider stream. File ops (`<read-files>`/`<modified-files>`) carry forward across compactions. If compaction fails it is cancelled with a notification rather than falling back to the buggy native path.
- **Fix: subagent routing (issue #19)** — provider calls from subagents while a parent query is active now start a nested query instead of being mistaken for empty tool-result delivery.
- **Fix: session preservation across `/compact` and tree nav (issue #25)** — the main Claude Code session is no longer clobbered by shorter synthetic contexts (compact summaries) or stale post-rewrite history.
- **Add: plan-aware 1M context (issue #24)** — new `provider.plan` (default `"pro"`) and `provider.longContextExtraUsage` config. See README for which models get 1M on which plan.
- **Add: reasoning token tracking** — Claude Code `reasoning_tokens`/`thinking_tokens` are preserved on pi usage objects and in debug logs.
- **Bump: pi 0.80 APIs** — compat catalog import, `CONFIG_DIR_NAME`, compaction metadata. Claude Agent SDK 0.2.x, TypeBox 1.3, tsx 4.22.

## 0.5.0 — 2026-06-05

- **Add: claude-opus-4-8 model** — migrated pi imports/dev peers from deprecated `@mariozechner/*` packages to `@earendil-works/*` 0.78.x so the official pi-ai registry supplies Opus 4.8. The `opus` shortcut now resolves to 4.8; 4.7/4.6 remain available for explicit pinning.
- **Docs: Agent SDK quota warning** — note Anthropic's announced June 15, 2026 Agent SDK billing/quota change.
- **Tests: isolate AskClaude config** — AskClaude integration tests now use project-local test config so they are unaffected by a user's global `askClaude.enabled` setting.
- **Tests: harden shell integration tests** — use explicit alternate provider/model settings and pre-increment counters under `set -e`.

## 0.4.0 — 2026-05-04

- **Fix: Opus 4.7 + xhigh sent wrong effort to SDK** — pi-ai 0.72 ships per-model `thinkingLevelMap` overrides (e.g. `claude-opus-4-7` declares `xhigh→xhigh`, not `xhigh→max`), but our hardcoded `REASONING_TO_EFFORT` table ignored them. Effort lookup now consults `model.thinkingLevelMap` first, falls back to the table for older pi-ai or unmapped levels. Forwarded `thinkingLevelMap` through `buildModels` projection.
- **Fix: zero out model cost in `buildModels`** — per-token pricing in the footer was wrong because models inherited pi-ai's non-zero cost fields, which pi then multiplied by the huge token counts from the SDK. Now explicitly zeroed so pi's footer shows no cost.
- **Use `tools: []` instead of `disallowedTools` blocklist** — switch from blocking specific tools to explicitly passing an empty tools list, preventing any new default tools from silently leaking into bridge sessions.
- **Disable CC-side autocompact (`DISABLE_AUTO_COMPACT=1`)** — pi already owns context management and propagates its own `/compact` to CC. Letting CC autocompact too double-flushed the prompt cache and raced pi's threshold; manual `/compact` in CC is unaffected.
- **Fix: pi `/compact` no longer triggers CC autocompact-thrashing (issue #8)** — pi's compaction shrinks its messages array, but `syncSharedSession`'s REUSE check (`slice(cursor)`) silently returned `[]`, so the bridge kept `--resume`ing the pre-compact CC session JSONL. Over long sessions CC's own autocompact then refilled within 3 turns and tripped its anti-thrashing guard. Now subscribes to pi's `session_compact` event and forces the next sync down the REBUILD path so CC sees the post-compact history. Also subscribes to `session_tree` (branch nav has the same shape).
- **Refactor: split `needsRebuild` into `needsRebuild` + `forceRotate`** — only the abort case needs UUID rotation (to dodge late writes from the dying CC subprocess). Compact/tree now rebuild in place, preserving the sessionId and not leaking orphan JSONL files into `~/.claude/projects/`.
- **Block user-installed MCP servers from leaking into bridge sessions** — pass `--strict-mcp-config` unconditionally and set `ENABLE_CLAUDEAI_MCP_SERVERS=0` in the spawned CC env, suppressing both filesystem (`~/.claude.json`, `.mcp.json`) and claude.ai cloud MCP servers. Override with `provider.strictMcpConfig: false`.
- **Consolidate config** — SDK plumbing (`appendSystemPrompt`, `settingSources`, `strictMcpConfig`) moved from `~/.pi/agent/settings.json` (`claudeAgentSdkProvider` block) to a `provider` block in `~/.pi/agent/claude-bridge.json`. Old location no longer read. Drop deprecated, unsafe `maxHistoryMessages`.
- **Bump deps** — `@anthropic-ai/claude-agent-sdk` → ^0.2.126; migrate to TypeBox 1.x (new import paths per pi-mono 0.69); pi devDeps → ^0.72.1. Extract `registerTool` schemas to const with explicit `<typeof params>` generic to avoid TS2589 deep-instantiation under TypeBox 1.x.
- **Internal: move sources into `src/`** — `index.ts` and the extracted modules now live under `src/`; screenshots under `assets/`. `pi.extensions` and published `files` updated accordingly.

## 0.3.1 — 2026-04-18

- **Fix: empty thinking blocks on Opus 4.7** — Opus 4.7 silently changed default `thinking.display` from `"summarized"` to `"omitted"`, so streams emitted `thinking_start` + `signature_delta` with zero `thinking_delta` events, leaving `ThinkingBlock.thinking == ""`. Now pass `--thinking-display=summarized` via `extraArgs` whenever `effort` is set (both provider and AskClaude paths). Bump `@anthropic-ai/claude-agent-sdk` to ^0.2.111 (required for Opus 4.7 + `--thinking-display` CLI flag). See [anthropics/claude-agent-sdk-python#830](https://github.com/anthropics/claude-agent-sdk-python/pull/830).
- **Fix: `cachePct` debug metric misleading** — denominator was `input + cacheRead`, so once a conversation warmed up (tiny `input`, huge `cacheRead`) every turn rounded to 100% — even turns that rebuilt the cache from scratch. Now `cacheRead / (input + cacheRead + cacheWrite)`, so cache-rebuild turns show a low percentage.
- **Internal: extract pure modules from `index.ts`** — split `models`, `skills`, `session-verify`, `extract-tool-results`, and `query-state` into their own TS files with real unit tests (no more `.js`+`.d.ts` mirror drift). Add `typecheck` script, `typescript` + `tsx` devDeps; test scripts run via `--import tsx`.

## 0.3.0 — 2026-04-17

- **Add: claude-opus-4-7 model** — Added `claude-opus-4-7` as a selectable model. The `opus` shortcut now resolves to 4.7 by default; 4.6 remains available for explicit pinning. Bumped `@mariozechner/pi-ai` to ^0.67.6 to include official model definitions (removed fallback).
- **Refactor: QueryContext class replaces module-level state** — 12 mutable `let` variables + manual `SavedQueryState` push/pop replaced with a `QueryContext` class and context stack. Adding new per-query state is now 1 property instead of 6 edit sites. Fixes `deferredUserMessages` not being isolated across reentrant queries (subagent could consume parent's deferred steers). MCP handlers now close over captured context, abort handler captures context at the correct point after push.
- **Fix: MODELS baseUrl leak** — the MODELS array exported to pi's provider registration now projects only the fields pi needs (id/name/reasoning/input/cost/contextWindow/maxTokens), stripping pi-ai's `baseUrl`/`api`/`provider`/`headers` so they can't shadow the values `registerProvider` supplies.
- **Internal: `repairToolPairing` moved to cc-session-io 0.3.0**; convert logic extracted to `convert.js` with `convert.d.ts` types; various dead-code / type-safety cleanup.

## 0.2.0 — 2026-04-15

- **Fix: stale cursor after tool-using first turn (issue #4)** — after the first turn used tools, the session cursor pointed at the wrong message, causing Claude to re-process stale context. Now correctly advances past all tool_result blocks.
- **Fix: session resume on symlinked paths / CLAUDE_CONFIG_DIR** — cc-session-io now resolves symlinks (realpathSync + NFC) and honors `CLAUDE_CONFIG_DIR`, matching how Claude Code resolves session paths. Fixes "No conversation found" on macOS symlinked dirs. Bump cc-session-io → 0.2.0.
- **Verify-after-write for session files** — warns with diagnostic context if the written session file doesn't round-trip correctly, instead of letting Claude silently resume a corrupt session.
- **Session rebuild preserves sessionId** — provider switches no longer churn UUIDs.
- **CC CLI debug capture** — `CLAUDE_BRIDGE_DEBUG=1` now also writes Claude Code's own debug stream to `~/.pi/agent/cc-cli-logs/`, one file per query.
- **Fix: debug() logged Error objects as `{}`** — now formats with message and stack.
- **Repair orphan tool_use/tool_result pairs before import** — prevents potential API 400s when history starts mid-turn after a provider switch.

## 0.1.6 — 2026-04-10

- **Fix: steer messages during tool execution now reach Claude** — when a user sends a steer while a tool is executing, pi injects it into context alongside the tool result. The bridge previously only processed tool results in this path, silently dropping the steer. Now detected and replayed as a continuation query after the current query completes.
- **Fix: "No conversation found with session ID" in dirs with dots/underscores/spaces** — bump `cc-session-io` to 0.1.2; `projectPathToHash` now matches the CLI's sanitization (`/[^a-zA-Z0-9]/g` → `-`) instead of only replacing slashes
- **Fix: steer/followUp during tool execution no longer hangs** — `extractAllToolResults` now walks past injected user messages instead of stopping at them
- **ID-based tool result matching** — tool results are matched to MCP handlers by `toolCallId` instead of FIFO position; eliminates silent wrong-result delivery if order diverges
- Add integration tests for tool execution scenarios (normal, followUp, steer, parallel+steer, abort) with auto-restart on failure
- Add `defaultIsolated` config option for AskClaude
- Remove skill path aliasing (`.pi/` → `.claude/` round-trip); pass through real paths instead
- Rewrite skills block to reference MCP-bridged read tool (`mcp__custom-tools__read`)
- **Fix: AskClaude action summary showed raw SDK tool names** — normalize `mcp__custom-tools__*` and SDK names at creation; hide redundant `BashOutput` and recursive `AskClaude`; collapse only consecutive same-tool calls
