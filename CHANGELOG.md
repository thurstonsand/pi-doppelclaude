<!-- markdownlint-disable MD024 -->

# Changelog

## 0.11.0 — 2026-09-11

### Added

- **`oauthTokenCommand` setting** — a command that prints a long-lived subscription token, run once at startup to populate `CLAUDE_CODE_OAUTH_TOKEN` for the Claude Code subprocesses. Allows for pulling credentials from a password manager.

## 0.10.1 — 2026-09-03

### Added

- **Use models before pi.dev reports them** — when Anthropic releases new models, they will show up in Claude Code before being present from pi.dev. In those cases, surface them as selectable, but missing some of the metadata from pi. Still fully usable.

### Fixed

- **Stop re-sending the entire conversation after compactions** — after a `/compact` or a rewind, each later turn rebuilt the transcript into a fresh Claude Code process, often paying the full cache cost again.
- **A failed tool call no longer degrades the rest of the session** — a tool handler left waiting for a result it could never get would strand the query, and every later turn in that conversation got its own throwaway Claude Code subprocess. Terminal errors now release whatever is still waiting.
- **Stop allowing tools during compaction** — explicitly set `toolChoice: "none"` for summarizer.
- **Better selection of system prompt replacement** — tune the regex to better select the part of the system prompt to replace, preventing accidental replacements elsewhere.

### Changed

- Bump to pi 0.84.3
- Improved logging of session rebuilds so that it's easier to track why

## 0.10.0 — 2026-08-16

### Fixed

- **Tool calls stream** — a `write` or `bash` call wouldn't stream in as it writes. The bridge now requests streaming so it doesn't just sit there until completion.
- **Long tool descriptions arrive whole** — Claude Code truncates every MCP tool description at 2048 characters, and pi has no such limit, so oversized descriptions were getting cut off. Migrate those descriptions (only) to the system prompt where there's no length limit.

### Added

- **`toolDescriptionCap` setting** — unset probes the Claude Code binary for its actual limit, a number pins it, `false` turns the relocation off.

## 0.9.0 — 2026-08-06

### Changed

- **Requires pi 0.84** — the model catalog now rides pi's publication contract: pi owns catalog storage, supersession fencing, and write ordering, so the bridge's own generation counter and write chain are gone. Failed fetch attempts are recorded as ordinary checks, matching pi's catalog flow.

### Added

- **Catalog refetches revalidate with ETag** — the 4-hourly pi.dev catalog fetch sends `If-None-Match` and takes the body-less 304 when nothing changed.

### Fixed

- **A logged-out Claude Code is reported as such** — instead of Pi's misleading "No API key found for doppelclaude" pointing at the unrelated `/login` flow, auth failures now name `claude auth login` and the restart/`/model` recovery paths.

## 0.8.2 — 2026-08-04

### Fixed

- **`/reload` no longer breaks the session with "Unsupported Doppelclaude model"** — after a reload, the next message could fail with `Unsupported Doppelclaude model: doppelclaude/<model>`, and stayed broken until the model was picked again from `/model`.

## 0.8.1 — 2026-08-04

A review pass over upstream [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge)'s recent activity; the fixes below are ported from it.

### Fixed

- **Claude Code no longer writes auto-memory** — it was unintentionally saving its own notes to `~/.claude` during bridge turns.
- **Parallel tool calls survive session rebuilds** — when a conversation had to be rebuilt, only the first result of a parallel tool batch made it through; the rest were silently replaced with "[no tool result recorded]" stubs. All results now survive.
- **Images in tool results survive rebuilds too** — screenshots and other images returned by tools were being flattened to text and lost.
- **Rebuilds no longer tell Claude it has built-in tools** — a rebuilt conversation could name old tool calls after Claude Code's own tools (`Read`, `Bash`, ...), tempting the model to call tools that don't exist here.

### Added

- **Tests now replay real recorded Claude Code streams** — instead of hand-written imitations. Re-record on an SDK bump and the diff shows exactly what the SDK changed.
- **Diagnostic tools for inspecting Claude Code's API traffic** — a capture proxy and a request differ in `diag/`, plus a doc of confirmed findings about caching and a resume-ordering bug in CC itself.

## 0.8.0 — 2026-08-02

### Added

- **Add: doppel session model** — every provider call now runs in its own _doppel_, the Claude Code counterpart of one conversation, keyed by the pi session id it carries. This enables multiple parallel sessions to exist within the same process, important for certain extensions that trigger their own inference.
- **Add: retry-once on a dead query** — If the underlying Claude Code session errors out for any reason, try again one time to catch any potentially transient issues.

### Fixed

- **Fix: rewinds rebuild instead of degrading** — `/undo` and session-tree navigation to a shorter history now plan a proper transcript rebuild. Previously the shorter context was mistaken for an auxiliary call and the conversation fell into cache-less one-shot queries for the rest of the session.

### Changed

- **Debug: log lines name their doppel** — `syncResult`, fresh-query, and turn-completion lines carry `doppel=<kind>:<key8>` (e.g. `doppel=host:019fbf9c`, `doppel=ephemeral:4ad75ca2`), so interleaved conversations in one process are distinguishable in `~/.pi/agent/doppelclaude.log`.

---

> ## `pi-claude-bridge` is now `pi-doppelclaude`
>
> Version 0.7.0 is the first release published from this fork, under a new name and a new npm package: **`pi-doppelclaude`**.
>
> Everything below 0.7.0 was released by [Eli Dickinson](https://github.com/elidickinson) as [`pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge), which was itself based on [`claude-agent-sdk-pi`](https://github.com/prateekmedia/claude-agent-sdk-pi) by [Prateek Sunal](https://github.com/prateekmedia). That history is preserved here in full. The two packages are independent from 0.7.0 forward.
>
> The provider ID, settings key, environment variables, and log paths all changed with the name. See the 0.7.0 entry for the migration.

---

## 0.7.0 — 2026-07-28

The fork's first release. Between 0.6.2 and here, essentially every layer was rewritten: the provider registration, the model catalog, the settings surface, the session store, and the tool dispatch path.

### Renamed

- **Rename: `pi-claude-bridge` → `pi-doppelclaude`** — new npm package, new GitHub repository, new provider identity. Nothing is aliased and nothing migrates automatically:
  - Provider ID `claude-bridge` → `doppelclaude`, so `claude-bridge/claude-opus-4-8` becomes `doppelclaude/claude-opus-4-8`. Update `/model` selections, `defaultProvider`, and `defaultModel`. Sessions pinned to the old provider will not resolve.
  - `~/.pi/agent/claude-bridge.json` and project-level `.pi/claude-bridge.json` are gone. Move their contents under a `doppelclaude` key in `~/.pi/agent/settings.json`.
  - `CLAUDE_BRIDGE_DEBUG` → `DOPPELCLAUDE_DEBUG`, `CLAUDE_BRIDGE_DEBUG_PATH` → `DOPPELCLAUDE_DEBUG_PATH`.
  - Default log path `~/.pi/agent/claude-bridge.log` → `~/.pi/agent/doppelclaude.log`.
- **Docs: README rewritten** — reorganized around the system prompt requirement, with the model catalog, cost accounting, and debugging surfaces documented against the current implementation rather than the pre-rewrite one.

### Added

- **Add: native pi Provider** — replaces the legacy `registerProvider(name, config)` shape and its fake API key, synthetic base URL markers, and partial model projection. Authentication is ambient: a closed, no-prompt Agent SDK control query validates a first-party Claude Code account, concurrent checks share one in-flight probe, and `/login doppelclaude` opens an informational dialog instead of asking for a key pi will never hold.
- **Add: bring-your-own system prompt** — Anthropic matches on pi's system prompt to detect and refuse the Agent SDK running under another harness. The identifying passages are now replaceable through `provider.systemPromptReplacements`. Every replacement is required, since a bundled fallback would just be one more fixed string to match on.
- **Add: dynamic model catalog** — the hardcoded model IDs are gone. The catalog is what Claude Code advertises intersected with what pi can describe, with bundled metadata as the floor and pi's canonical remote catalog overlaid on top. Dated snapshots normalize onto the family ID so sessions persist; mutable aliases like `sonnet` name no family and never enter the catalog. Discovery costs a Claude Code boot, so it runs once on an installation with no cached allowlist and not again.
  - One exception: when Claude refuses to answer a question and falls back to a dumber model, that model gets registered ad-hoc as it appears.
- **Add: Anthropic Agent SDK 0.3 integrity signals** — served-model accounting now diffs cumulative per-model `modelUsage` at each terminal result, so a fallback turn is priced from the model actually served while keeping the requested model as message identity. Structured rate-limit buckets, `api_retry` status, and assistant error categories map to pi warnings and 429/529 terminal errors. Where the SDK's declarations fall short, the bridge fails closed rather than reconstructing private wire contracts.
- **Add: live MCP reconciliation** — a changed pi tool set reconciles through verified `setMcpServers()` receipts on the running process instead of rotating the Claude Code session.
- **Add: persistent streaming query** — one streaming-input query stays alive across compatible top-level turns, with steering routed through a typed push queue and model-only changes applied via `setModel`. Reentrant work still uses one-shot queries.

### Changed

- **Refactor: configuration moved into pi's settings** — the dedicated `claude-bridge.json` files (global and project) are no longer read at all. Configuration is one `doppelclaude` key in global `~/.pi/agent/settings.json`.
- **Refactor: SDK-backed session store** — session state is an authoritative in-memory `SessionStore` keyed by session UUID with per-query revision fencing, replacing direct Claude Code JSONL rewriting and its path hashing, filesystem verification, and post-abort UUID rotation. Completed queries drain to natural EOF before replacement so every mirror frame flushes; first-spawn JSONL fragments are deleted after the writer provably exits, so stale sessions stop appearing in `claude --resume`.
- **Change: `models.json` overrides now apply** — 0.6.2 could not be tuned without editing `src/models.ts`, because pi did not apply `modelOverrides` to extension-registered providers. pi 0.82 does, and the composed result drives display, compaction threshold, and the Claude Code request form. Adding models, or overriding `api` or `baseUrl`, remains unsupported and hides the model.
- **Refactor: typed test suite** — Node tests and the RPC harness moved to TypeScript, and the shell/Python usage diagnostic became typed Node.
- **Bump: Claude Agent SDK 0.3.219, pi 0.82** — the minimum peer floor for `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` is now 0.82.0.

### Removed

- **Remove: AskClaude** — There are plenty of other ways to implement the subagent pattern.
- **Remove: `provider.plan` and `provider.longContextExtraUsage`** — 1M context is now decided by the composed `contextWindow` after `modelOverrides`, so a model above 200K requests Claude Code's `[1m]` form and Claude Code remains responsible for authorization.
- **Remove: `provider.strictMcpConfig` and `provider.settingSources`** — MCP isolation is unconditional, since pi is the tool-execution layer. `settingSources` is now implied by `systemPromptMode`: `"pi"` mode isolates Claude Code from its own settings files, and the other modes leave its defaults alone.

- **Change: bridged `bash` no longer gets a 120-second timeout** — 0.6.2 injected one whenever the model omitted the argument, mirroring Claude Code's own Bash tool. But pi advertises its schema to the model verbatim, and that schema says `Timeout in seconds (optional, no default timeout)`. Omitting the argument now means what it says, so a long-running command runs to completion and the model asks for a bound when it wants one.

### Fixed

- **Fix: SDK failures surfacing as successful empty turns** — SDK and MCP failures propagate as terminal pi errors, fatal MCP failures survive stream handoff, and handlers match on Claude Code's native tool-use ID rather than call position, so parallel calls cannot be misrouted.
- **Fix: compaction summary usage lost** — isolated Claude Code summaries reported synthetic zero usage, leaving compaction unaccounted for in session totals. They now share the same usage mapper as ordinary turns.

## 0.6.2 — 2026-07-06

- **Fix: Sonnet 5 and Fable 5 with 1M context** — bare model IDs (`claude-sonnet-5`, `claude-fable-5`) are 200K context. Must pass `[1m]` suffix for both, similar to Opus 4.8.
- **Fix: xhigh thinking level hidden for Sonnet 5 and Sonnet 4.6 (issue #32)** — pi-ai ships no `thinkingLevelMap` for these models, and pi's `getSupportedThinkingLevels` requires an explicit mapping to show `xhigh` in the picker. This is a workaround for <https://github.com/earendil-works/pi/issues/6371>

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
