# HTTP Frontend: an Anthropic Messages endpoint over the bridge

## Status

Draft

## Decision Summary

Split the bridge into a **core** package that speaks Messages API shapes and two **frontends**: the existing pi provider, and a new HTTP daemon that serves `POST /v1/messages` so a client with a "custom Anthropic-compatible URL" setting — Amp first — can drive Claude Code through the Agent SDK. The tradeoff: core must give up pi's types and pi's session id, and identify conversations by matching histories, because the target client sends no conversation key at all.

## Problem Statement / Background

The bridge already makes a stateful harness (Claude Code, via the Agent SDK) impersonate a stateless provider for one client, pi. The awkward part is done: the doppel model, the three sync paths, the blocking MCP bridge that hands tool execution back to the caller, the description-cap relocation, refusal and usage accounting. What pi cannot give us is the other clients. Amp's experimental Custom URL connection accepts an Anthropic Messages endpoint. So does T3 Code. Neither will load a pi extension.

A spike on 2026-09-15 (`diag/AMP-WIRE-BEHAVIOR.md`, tooling in `diag/amp-recorder/`) put a recording endpoint behind a Cloudflare quick tunnel and drove Amp through it from `amp -x` with a project plugin mode bound to `doppelclaude/claude-opus-5`. It settled the facts this design rests on:

- Amp's **servers** call the endpoint, from Google Cloud addresses. The daemon faces the internet.
- Amp sends **no conversation identifier**: stock Anthropic JS SDK headers, no `metadata`. The pi frontend keys doppels on `options.sessionId`; the HTTP frontend has nothing to key on.
- Amp **rewrites `tool_use` ids** (`toolu_…` becomes `TU-…`) on both the call and its result, so the transcript Claude Code holds and the history Amp sends never agree on ids.
- Amp **echoes thinking blocks with signatures intact**, and its history is **byte-stable** across turns apart from `cache_control` placement.
- Amp runs **compaction client-side through the connection** as an ordinary-looking request with a summarization instruction appended, then replaces its history with the summary.
- Amp **does not retry** a 529. Subagents and thread titles never touch the endpoint.
- The model arrives provider-qualified, `doppelclaude/claude-opus-5`; `max_tokens` is 128,000; thinking is `adaptive`/`summarized`; effort is `high`; 43 tools, six of them over Claude Code's 2048-character MCP description cap.

Design 03 already rejected one-query-per-turn: the Agent SDK does not accept an injected `tool_result`, so any tool-using conversation needs a live query with the MCP handler left pending. That constraint carries over unchanged, and is why the HTTP frontend cannot be a stateless translator.

Also surfaced during the spike, unrelated to Amp: the README claims `maxTokens` "caps the response length requested per turn", but `src/models.ts` uses it only for catalog display and nothing passes it to Claude Code. `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is the knob and it is unset.

## Goals

- A daemon that Amp's Custom URL connection can use for a full coding conversation: multi-turn, tools executed by Amp, thinking preserved, interruption survivable.
- One core shared by both frontends, so a fix to sync planning or the MCP bridge lands for pi and HTTP at once.
- Prompt-cache hits across turns comparable to today's pi frontend: the same bytes reach the API on the same warm process unless the client changed history.
- Every request the daemon cannot map is logged with the client's full header set, so the next client's quirks are observable on day one.

## Non-Goals

- Serving anyone but the account owner. The daemon is a personal proxy; the legal-and-compliance page forbids intermediating subscription credentials for others.
- T3 Code or any second client in v1. Amp is the target; the wire is the Messages API, so others should follow, but nothing is validated against them.
- Persisting doppels across daemon restarts in v1 (see Alternatives).
- Cancel semantics beyond what the pi frontend already has. The Amp app's mid-stream cancel has not been observed on the wire.
- Non-streaming responses. Amp sends `stream: true` on every request; the daemon may answer `stream: false` with a 400 until a client needs it.

## Exposed Shape

### HTTP frontend → client (Amp)

- `POST /v1/messages`, streaming SSE only. Request body is a Messages API `MessageCreateParamsStreaming`, validated at the edge with schemas written against `@anthropic-ai/sdk` types. Response is the raw `RawMessageStreamEvent` sequence the Agent SDK emits under `includePartialMessages`, re-encoded as `event:`/`data:` frames. `stop_reason` is `tool_use` when the model called a client tool, `end_turn` otherwise; `usage` comes from `message_delta`.
- `GET /v1/models`: the model catalog in Models API shape. Amp never calls it today; serve it because the dialog's Configure button looks like it means to.
- Authentication: the daemon checks the key on `Authorization: Bearer` or `x-api-key`. Unauthenticated: 401 with an Anthropic-shaped error body.
- Model: `provider/model` is accepted; the provider segment is stripped and ignored. A bare model id is also accepted.
- Parameters honored: `system`, `messages`, `tools`, `max_tokens` (at spawn only), `thinking.display`, `output_config.effort`, `tool_choice: none` (empty tool set). Dropped with a debug log: `temperature`, `top_p`, `top_k`, `stop_sequences`, `metadata`, `cache_control`. Coerced to `auto` with a debug log: `tool_choice: any|tool`. Rejected 400: `n > 1`, `stream: false`.
- Errors: Anthropic error envelope. Upstream 429/529 are retried by the daemon per its own policy before one is surfaced, since Amp retries nothing.

### Core `turn()` contract (both frontends → core)

```ts
turn({
  key?: string;                 // frontend-supplied doppel key; absent for HTTP
  model: string;                // bare Claude Code model id
  system: string;               // client system blocks joined, text preserved byte-for-byte
  messages: MessageParam[];     // Messages API history, client tool ids as sent
  tools: Tool[];                // client tool definitions, schemas verbatim
  effort?: Effort;
  thinkingDisplay?: 'summarized' | 'omitted';
  maxOutputTokens?: number;     // applied at spawn; ignored on a live doppel
  signal: AbortSignal;
}): AsyncIterable<RawMessageStreamEvent>
```

Core owns: doppel registry and lifecycle, conversation match (when `key` is absent), sync planning, session store, MCP bridge, query spawn/reuse/retry, description-cap relocation, refusal, usage. It emits raw Messages API stream events and nothing pi-shaped.

### pi frontend → core

`convert.ts` (pi messages → `MessageParam[]`), tool-result extraction, and `provider-stream.ts` (stream events → pi events) move into the pi package as the adapter. The pi frontend always supplies `key = options.sessionId`.

### Core → Claude Code (Agent SDK)

Unchanged in kind: `query()` with `tools: []`, one in-process MCP server advertising the client's tools with `alwaysLoad` (or `ENABLE_TOOL_SEARCH=false` in the child env if the sdk-server config cannot express it), custom `systemPrompt` string, `settingSources: []`, `DISABLE_AUTO_COMPACT=1`, plus `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the first request. New: `forkSession` when a conversation match finds a fork.

### Daemon → network

Behind the Cloudflare tunnel and an Access application. The same pattern as `wrangler/aig/worker.ts` in ansiblonomicon fronts cliproxyapi: a Worker validates the client key and injects the Access service token toward the origin. The daemon still checks the key itself. Configuration of the tunnel, Access, and Worker lives in ansiblonomicon, not here.

### Package layout

npm workspaces, one repo:

- `packages/doppelclaude` (core)
- `packages/pi-doppelclaude` (pi frontend; published name unchanged)
- `packages/http-doppelclaude` (HTTP frontend; binary `doppelclaude-serve` or similar)

## Call Stacks and Data Flow

### A turn through the HTTP frontend

```txt
POST /v1/messages
  authenticate(headers)                          401 on miss
  parseRequest(body)                              zod over @anthropic-ai/sdk types; 400 on shape error
  stripProvider(model)                            "doppelclaude/claude-opus-5" -> "claude-opus-5"
  core.turn({ system, messages, tools, model, effort, thinkingDisplay, maxOutputTokens, signal })
    canonicalize(messages)                        drop cache_control; tool ids -> turn-relative positions
    matchConversation(canonical)                  longest-prefix among live doppels
      -> extends one doppel by ≤1 user turn      reuse   (push into warm query, or resolve pending MCP handlers)
      -> diverges inside one doppel               rebuild (synthesize transcript, replace store entry, resume)
      -> extends a doppel that is mid-turn or
         already extended by another live turn   fork    (forkSession from the shared prefix -> new doppel)
      -> no overlap                               clean-start (new doppel, spawn)
    planTurn / spawn or reuse                     unchanged from today, minus pi
    stream SDK messages
      stream_event -> yield RawMessageStreamEvent
      tool_use from MCP handler -> yield block; on message_delta emit stop_reason: tool_use; keep handler pending
  encodeSSE(events) -> response
  on client disconnect -> signal.abort() -> query.interrupt() -> settleInterruptedQuery (existing)
```

### Tool round trip

```txt
turn N   : model calls mcp__client__shell_command -> MCP handler blocks on a promise
           daemon yields tool_use block, message_delta{stop_reason: tool_use}, message_stop, ends SSE
client   : executes shell_command, sends turn N+1 with history + tool_result (its own tool id)
turn N+1 : canonicalize -> match -> reuse
           pair tool_results to pending handlers by position within the turn (ids differ by client)
           resolve promises -> model continues on the same warm query
```

### Compaction (Amp-initiated)

```txt
request K   : history H + user "[inserted by Amp] write a handoff summary…"   -> reuse (one user turn appended)
              model writes the summary as a normal turn on the warm query; cache hit on H
request K+1 : history = [summary as user turn] + retained tail                -> no prefix overlap with H
              -> clean-start (or fork if the tail overlaps) ; old doppel idles out
```

Claude Code's own auto-compaction stays disabled (`DISABLE_AUTO_COMPACT=1`), so Claude Code's transcript never diverges from the client's history on its own.

### Failure and retry

```txt
SDK result error / dead query       -> existing retryDeadQuery (once, before first assistant output)
upstream 429/529 surfaced by CC     -> daemon retry policy (backoff, max N), then Anthropic error envelope
refusal stop_reason                 -> existing refusal handling; served model recorded in usage
pending handler never resolved      -> doppel idle deadline expires -> close query, drop doppel
```

## Design Decisions

### 1. Core speaks Messages API shapes

The Agent SDK's transcript is already Messages API shaped, `convert.ts` already targets it, and the HTTP frontend receives it directly. Any other neutral type would be a third dialect nobody else speaks. The pi frontend pays one conversion on the way in and one on the way out, both of which exist today. This is the hardest decision to reverse: it decides where every later feature lands.

### 2. Three packages in one workspace

Not for reuse by strangers: for the boundary. A core that imports nothing from `@earendil-works/pi-*` cannot quietly grow pi assumptions again (18 of 29 source files import pi types today). npm workspaces; `pi install npm:pi-doppelclaude` pulls core transitively.

### 3. Conversation match by canonical prefix, with client-supplied keys as a shortcut

Amp sends no key. Even a client that does (pi's `x-session-affinity`, OpenCode's `x-opencode-session`) can edit its history at will, so the sync planner compares histories regardless; a key only narrows the search to one doppel. Core therefore takes an optional key and falls back to longest canonical-prefix match across live doppels. Canonicalization drops `cache_control` and replaces tool ids with turn-relative positions, because Amp rewrites ids and pairs `tool_use`/`tool_result` by its own. The frontend logs every header on a first request from an unfamiliar user agent so a future client's key, if any, is noticed.

### 4. Forks become doppels

Two live requests that share a prefix and diverge are two conversations. `forkSession` branches the Claude Code session from the shared prefix, so the fork's first request reads the parent's cache. Chosen over "rebuild the one doppel" for simplicity of reasoning, at the cost of one more warm process per fork. `forkSession` was already on the TODO to measure; this is the consumer that needs it.

### 5. Every HTTP conversation is a warm host

Design 03's host/guest/ephemeral split is pi identity. Here every conversation wants the warm query, and none can be told apart by kind. One kind, with an idle deadline aligned to the cache TTL (one hour on subscription) and an LRU cap on concurrent processes. Pending MCP handlers wait until the deadline; a request after that rebuilds. Design 03 deferred the idle deadline until a consumer materialized. This is it.

### 6. System prompt passes through as one string, bytes preserved

Amp sends three system blocks whose only per-block semantics is `cache_control`, which Claude Code manages itself. The SDK's custom `systemPrompt` accepts one string, or two halves around `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`; it cannot carry N blocks. Join the block texts with no separator so the model sees the same bytes, and let the snapshot behavior stay on so a client that drifts its prompt does not thrash the cache. Description relocation prepends its block as it does today; `insertRelocatedToolBlock` already falls back to prepending when its pi anchor is absent. No replacement rules until a request is actually blocked for its prompt.

### 7. Tools load upfront

`alwaysLoad` (or `ENABLE_TOOL_SEARCH=false`), not tool search deferral. Amp's prompt assumes the model sees every tool; Amp's own deferral is client-side (`tool_search` plus `code_exec`) and invisible on the wire. The tool set is identical across a thread, so the prefix stays stable either way; upfront loading spends prefix tokens once rather than a round trip per first use. Open fact: whether the pi frontend is deferring today. The bridge never sets the knob, so it probably is; measure before flipping it for pi.

### 8. Parameter mapping is one-to-one or nothing

`effort` and `thinking.display` map to SDK options. `max_tokens` maps to `CLAUDE_CODE_MAX_OUTPUT_TOKENS` at spawn and is ignored afterwards, since it is per-process and respawning for it costs a resume. Sampling knobs are dropped with a log; the target models reject them anyway. `tool_choice: any|tool` coerces to `auto` with a log rather than a 400, because Fable 5.1 rejects forced tool use at the API and a 400 would punish the client for a field it cannot use. `none` is the empty tool set, as today. This also fixes the pi frontend: `maxTokens` there becomes real.

### 9. The daemon owns retries

Amp surfaces a 529 to the user on the first attempt. pi's retry policy comes from pi's settings manager, which the daemon does not have. The HTTP frontend carries its own retry configuration and applies it before an error reaches the client.

### 10. Public exposure: Worker key check plus Access, both

The API key alone would authenticate correctly. The Access layer is what keeps every unauthenticated packet off the home network and out of the daemon's logs, and the Worker that validates the key and injects the Access service token already exists for cliproxyapi. Reuse the pattern; the daemon's own key check stays as defense in depth.

### 11. `/v1/models` is served

Amp never calls it and offers no discovery today. It is a few lines over the existing catalog, and the Configure button reads like a bug that will be fixed.

## Edge Cases & Failure Modes

- **Client cancels mid-stream (disconnect):** `interrupt()`, then the existing reusability check. The next request's history will end with truncated text and a thinking block without a signature (signatures arrive at `content_block_stop`); the match diverges at that turn and plans `rebuild`, and the rebuilt transcript must drop that partial assistant turn entirely, not trim it, or Fable 5.1's preserved-thinking check rejects it.
- **Two clients open identical conversations:** identical first turns match the same doppel until they diverge, at which point the second becomes a fork. Acceptable for a single-owner daemon.
- **Client drops thinking blocks from history:** the match still succeeds on text and tool blocks; the rebuild loses thinking. Amp does not do this; log a warning when a client does.
- **Amp compaction:** the summary request is a normal turn; the post-summary request is a new conversation. The old doppel idles out. Cost: one cold prefix for the short new history.
- **Compaction reply contains a tool call:** Amp retries three times then wedges the thread ("Compaction failed"). Claude Code answering a summary prompt with plain text is the normal case; nothing to do beyond not breaking it.
- **Daemon restart:** the in-memory store and doppel map are gone; every conversation rebuilds once on its next request. Thinking survives because the client echoes it.
- **`max_tokens` changes mid-conversation:** ignored, logged.
- **Tool set changes mid-conversation:** the existing live MCP reconciliation; with upfront loading this invalidates the prefix once.
- **Unknown model id after stripping the provider:** 400 with the catalog's ids in the message, as the pi frontend already does for unsupported models.
- **Pending tool handler abandoned by the client:** idle deadline closes the query; the doppel is dropped; a late request rebuilds.
- **Two hits on the daemon for the same conversation concurrently (Amp retry, or a fork racing):** the match sees the second as extending a doppel mid-turn and treats it as a fork rather than corrupting the live query.

## Alternatives

### Translate Messages API requests into pi `Context` and keep the runtime as is

- **Status:** Rejected
- **Decision:** Double conversion (Anthropic → pi → Anthropic) and pi-ai becomes a dependency of an HTTP daemon. The core prefactor costs more up front and removes the coupling permanently.

### Require a conversation key from the client

- **Status:** Rejected for Amp, kept as an optional shortcut
- **Decision:** Amp sends none, and the spike showed no place to put one (the dialog's Headers are static per connection). History comparison is needed anyway for edited histories; a key only shortens the doppel lookup.

### Persist a key-to-session index and resume from Claude Code's JSONL after restart

- **Status:** Open
- **Open issue:** cheap in principle, since the SDK's local transcripts survive; unclear how prefix-matched keys survive when the first message is edited.
- **Next step:** measure the rebuild-after-restart cost on a real Amp thread first. If it is one cold write and thinking survives, leave it.

### Hook-based deferral (`permissionDecision: "defer"`) instead of the blocking MCP handler

- **Status:** Rejected
- **Decision:** `defer` works only for a single tool call per turn and resume re-runs the same tool through `updatedInput`; it cannot hand execution to the client. The blocking handler handles parallel calls and already exists.

### Let Claude Code auto-compact

- **Status:** Rejected
- **Decision:** Claude Code's transcript would diverge from the client's history silently, forcing a rebuild on every subsequent turn. Keep `DISABLE_AUTO_COMPACT=1`; Amp compacts on its own schedule through the connection.

### Cloudflare Access service token alone, no daemon key check

- **Status:** Rejected
- **Decision:** cheap to keep both; the Worker pattern already does both for cliproxyapi.

## Implementation Plan

Context for the implementer: `createBridgeRuntime` (`src/bridge-runtime.ts`) exposes `stream(model: Model<Api>, context: Context, options)`, extracts tool results from pi `toolResult` messages (`src/extract-tool-results.ts`), keys doppels on `options.sessionId`, and takes settings from `~/.pi/agent/settings.json`. `convert.ts` already produces Messages API blocks including signed thinking. Tests drive `runtime.stream` with pi contexts against a fake SDK query in `tests/lib/`. Integration tests spend real subscription quota; do not run them unasked. The user manages git staging personally.

- [x] Phase 0: Record Amp's wire behavior
  - Goal: Know what the client sends before designing for it.
  - Files: `diag/amp-recorder/server.mjs`, `diag/amp-recorder/README.md`, `diag/AMP-WIRE-BEHAVIOR.md`.
  - Work: done 2026-09-15; findings above.
  - Validation: the findings file.

- [ ] Phase 1: `maxTokens` reaches Claude Code
  - Goal: Fix the README's false claim in the pi frontend; establish the spawn-time env pattern the HTTP frontend reuses.
  - Files: `src/turn-plan.ts`, `src/sdk-child-env.ts`, `README.md`, `tests/unit-querycontext.ts` or a new unit test.
  - Work: pass `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the model's `maxTokens` into the spawn env; a change on a live query is logged and ignored; README wording matches.
  - Validation: `mise run check`; unit test asserting the env value; one live smoke reading `max_tokens` in a captured request (`diag/capture-proxy.mjs`).

- [ ] Phase 2: Core contract in Messages API shapes
  - Goal: `runtime.turn()` takes `{key?, model, system, messages, tools, effort, thinkingDisplay, maxOutputTokens, signal}` and yields raw stream events; pi conversion lives at the edge. No behavior change for pi.
  - Files: `src/bridge-runtime.ts`, `src/doppel.ts`, `src/query-state.ts`, `src/turn-plan.ts`, new `src/pi-adapter/` holding `convert.ts`, `extract-tool-results.ts`, `provider-stream.ts`; `src/provider.ts`.
  - Work: define the contract; move pi-message reading into the adapter, which builds `messages` and resolves tool results before calling `turn()`; the cursor counts Messages API messages; system-prompt rewriting stays in the adapter; `key` replaces direct `options.sessionId` reads inside the runtime. Keep the low-level MCP `Server` and blocking handlers as they are.
  - Validation: `mise run check`; existing unit suite green with the harness updated to build Messages API inputs; one live pi smoke turn with tools.

- [ ] Phase 3: Workspace split
  - Goal: `packages/doppelclaude`, `packages/pi-doppelclaude`, `packages/http-doppelclaude` (empty shell), root `workspaces`.
  - Files: `package.json`, `packages/*/package.json`, `tsconfig*.json`, `biome.json`, `mise.toml` tasks, `hk.pkl`, CI workflow, `DEV.md`.
  - Work: move core sources and the fake-SDK test harness into core; pi adapter and `index.ts` into the pi package; keep the published name `pi-doppelclaude`; confirm `pi install npm:pi-doppelclaude` resolves core from npm (publish core first, or use a workspace-aware pack for the check).
  - Validation: `mise run check` at root; `npm pack` of the pi package installs into a clean pi and runs the smoke turn.

- [ ] Phase 4: HTTP tracer bullet — one text turn
  - Goal: `POST /v1/messages` from Amp to `claude-opus-5` returns a real streamed answer. No tools, no matching beyond clean-start.
  - Files: `packages/http-doppelclaude/src/{server,auth,request,sse,models}.ts`, settings loader, tests at the HTTP boundary against the fake SDK.
  - Work: key check; zod validation over `@anthropic-ai/sdk` types; provider-prefix strip; parameter mapping and drop/coerce/400 policy from decision 8; system join; SSE encoder; `GET /v1/models`; header dump on first sight of a new user agent; daemon retry policy config.
  - Validation: HTTP boundary tests asserting SSE frames and `stop_reason`; live: daemon behind a quick tunnel, Amp custom connection, `amp -x -m <mode>` answers with real model text.

- [ ] Phase 5: Tools over HTTP
  - Goal: an Amp turn that calls `shell_command` completes: `stop_reason: tool_use`, Amp executes, the follow-up request resolves the pending handler on the same warm query.
  - Files: `packages/doppelclaude/src/{canonical,match}.ts`, MCP server config (`alwaysLoad` or `ENABLE_TOOL_SEARCH=false`), relocation wiring for a client system prompt.
  - Work: canonicalization (drop `cache_control`, positional tool ids); pairing tool results to pending handlers by position; `reuse` for "extends by one user turn"; relocation prepends when its anchor is missing.
  - Validation: HTTP tests for the two-request tool round trip with mismatched ids; live Amp `shell_command` turn with cache_read tokens non-zero on the follow-up.

- [ ] Phase 6: Conversation lifecycle
  - Goal: rebuild on divergence, fork on shared-prefix divergence, clean-start on no overlap; idle deadline and LRU cap; disconnect → interrupt → settle; unsigned partial thinking dropped on rebuild.
  - Files: `match.ts`, `doppel.ts` (deadline, cap), rebuild path, `forkSession` plumbing.
  - Work: as in the call stacks; measure `forkSession` cache behavior once and record it.
  - Validation: HTTP tests for each match outcome; live: Amp compaction cycle (low `compactionThresholdTokens` mode) produces a summary turn and a fresh doppel; a fork from the Amp app.

- [ ] Phase 7: Fronting in ansiblonomicon
  - Goal: the daemon reachable at a stable hostname behind Access, with the Worker key check and service-token injection, deployed as a service on the host that runs it.
  - Files: ansiblonomicon `terraform/cloudflare/`, `wrangler/`, host service definition.
  - Work: outside this repo; recorded here so the plan is complete.
  - Validation: `mise run edge:plan`/`apply`; Amp connection updated to the stable URL; one live turn.
