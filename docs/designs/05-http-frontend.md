# HTTP Frontend: an Anthropic Messages endpoint over the bridge

## Status

Implemented — native core, three installable packages, daemon lifecycle, and a repository-owned
daemon image. Production infrastructure consumption remains outside this repository.

The 2026-09-18 follow-up in `diag/AMP-WIRE-BEHAVIOR.md` found the actual current thread ID on an `Amp Thread URL:` line in system text in all 12 requests across two CLI threads. V1 requires that marker and fails closed if it is absent or ambiguous. This is an explicit Amp compatibility requirement, not a documented provider-protocol guarantee. The same follow-up observed `GET /v1/models`.

## Decision Summary

Serve an Amp-only `POST /v1/messages` endpoint over the bridge. Require exactly one labelled Amp thread URL in system text and use its thread ID to select the doppel; history validation decides reuse versus rebuild, never conversation identity. First prove two interleaved real conversations through a diagnostic adapter over the existing runtime. After that proof, extract a Messages-shaped **core** shared by the pi and HTTP **frontends**, then split packages. No global history-prefix search or identity-driven SDK forking is needed.

## Problem Statement / Background

The bridge already makes a stateful harness (Claude Code, via the Agent SDK) impersonate a stateless provider for one client, pi. The awkward part is done: the doppel model, the three sync paths, the blocking MCP bridge that hands tool execution back to the caller, the description-cap relocation, refusal and usage accounting. What pi cannot give us is the other clients. Amp's experimental Custom URL connection accepts an Anthropic Messages endpoint. So does T3 Code. Neither will load a pi extension.

A spike on 2026-09-15 (`diag/AMP-WIRE-BEHAVIOR.md`, tooling in `diag/amp-recorder/`) put a recording endpoint behind a Cloudflare quick tunnel and drove Amp through it from `amp -x` with a project plugin mode bound to `doppelclaude/claude-opus-5`. It settled the facts this design rests on:

- Amp's **servers** call the endpoint, from Google Cloud addresses. The daemon faces the internet.
- Amp sends **no dedicated conversation header or metadata**, but current CLI requests include `Amp Thread URL: https://ampcode.com/threads/<id>` in system text. The HTTP frontend requires that marker; pi supplies `options.sessionId`.
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
- Diagnostics identify the thread, sync path, errors, and token/cache usage without logging credentials or raw prompt content.

## Non-Goals

- Serving anyone but the account owner. The daemon is a personal proxy; the legal-and-compliance page forbids intermediating subscription credentials for others.
- T3 Code or any second client in v1. Requests without the Amp thread marker are unsupported, even if otherwise Messages API compatible.
- Global history-based identity matching or `forkSession` cache optimization.
- Persisting doppels across daemon restarts in v1 (see Alternatives).
- Cancel semantics beyond what the pi frontend already has. The Amp app's mid-stream cancel has not been observed on the wire.
- Non-streaming responses. Amp sends `stream: true` on every request; the daemon may answer `stream: false` with a 400 until a client needs it.

## Exposed Shape

### HTTP frontend → client (Amp)

- `POST /v1/messages`, streaming SSE only. Validate the supported Messages API subset with TypeBox at the edge. Translate SDK tool names and preserve tool-dispatch/rejection semantics; this is not raw SSE passthrough. Preserve actual stop reasons, including `max_tokens`, and input/output/cache usage.
- Identity: search all system text blocks (or a string system prompt) for exactly one complete matching line. Missing or multiple matches return `400 invalid_request_error` before inference. Ignore thread references in user messages and unrelated system prose. Authentication remains independent.
- `GET /v1/models`: the account probe's canonicalized, deduplicated model catalog in Models API shape; observed in the follow-up capture. It is discovery data, not a request allowlist.
- Authentication: the daemon checks the key on `Authorization: Bearer` or `x-api-key`. Unauthenticated: 401 with an Anthropic-shaped error body.
- Model: the requester supplies a stable bare Claude ID or `<provider>/<claude-id>` on every call. The HTTP boundary strips the optional provider prefix and forwards the exact bare ID, including date suffixes; model changes on a warm thread use core's normal rebuild path.
- Parameters honored: `system`, `messages`, `tools`, `max_tokens` (at spawn; changes require rebuild), supported adaptive thinking display, `output_config.effort`, `tool_choice: auto|none`. Ignore per-block `cache_control`, since Claude Code manages caching. Reject unsupported sampling, forced tool choice, and non-streaming requests with 400 rather than silently changing their meaning.
- Errors: Anthropic error envelope. Upstream 429/529 are retried by the daemon per its own policy before one is surfaced, since Amp retries nothing.

### Core `turn()` contract (both frontends → core)

```ts
turn({
  key: string;                  // validated Amp thread ID, or pi session/synthetic key
  model: string;                // bare Claude Code model id
  system: string;               // client system blocks joined, text preserved byte-for-byte
  messages: MessageParam[];     // Messages API history, client tool ids as sent
  tools: Tool[];                // client tool definitions, schemas verbatim
  effort?: Effort;
  thinkingDisplay?: 'summarized' | 'omitted';
  maxOutputTokens?: number;     // applied at spawn; changed limits require a rebuild
  signal: AbortSignal;
}): AsyncIterable<RawMessageStreamEvent>
```

Core owns the keyed doppel registry and lifecycle, sync planning, session store, MCP bridge, query spawn/reuse/retry, refusal, and native response/command usage. The implemented contract is `RuntimeRequest` in `src/runtime-request.ts`: `conversationKey`, `systemPrompt`, and `maxTokens` correspond to the sketch above; deliberate keyless requests set `ephemeral: true`. Tool definitions have bare MCP names; imported history has SDK-qualified names. Frontends supply spawn policy and name maps. Output includes Messages stream events, a final native response record, and explicit terminal errors. Command usage observations arrive separately because an SDK command can outlive a tool-use response.

The HTTP diagnostic now calls core directly, with no Pi types or reverse conversion. HTTP validates canonical history within the required thread key before core sync planning. Pi retains its prompt rewriting and description relocation at the adapter boundary; sharing relocation with the production HTTP package remains follow-up work.

### pi frontend → core

`pi-runtime.ts` prepares native requests using `convert.ts` and `turn-plan.ts`; `pi-response.ts` projects native events to Pi, and `pi-usage.ts` applies pricing and late command cost corrections. `provider-stream.ts` is now the core SDK consumer. Pi supplies `conversationKey = options.sessionId`, or explicitly requests an ephemeral doppel when no session ID exists.

### Core → Claude Code (Agent SDK)

Unchanged in kind: `query()` with `tools: []`, one in-process MCP server advertising the client's tools with `alwaysLoad` (or `ENABLE_TOOL_SEARCH=false` in the child env), custom `systemPrompt` string, `settingSources: []`, `DISABLE_AUTO_COMPACT=1`, plus `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. An Amp fork with a new thread ID opens a new doppel and imports its supplied history; no `forkSession` dependency.

### Daemon → network

The standalone daemon defaults to loopback. Its container defaults to `0.0.0.0` so deployment
networking can route to it directly, without an in-container reverse proxy. Edge authentication,
tunnels, secrets, immutable image selection, and service supervision live in deployment
infrastructure; the daemon still checks its own client key.

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
  parseRequest(body)                              TypeBox; 400 on unsupported shape
  requireAmpThreadId(system)                      exactly one labelled URL; otherwise 400
  stripProvider(model)                            "doppelclaude/claude-opus-5" -> "claude-opus-5"
  core.turn({ key: threadId, system, messages, tools, model, effort, thinkingDisplay, maxOutputTokens, signal })
    canonicalize(messages)                        drop cache_control; tool ids -> turn-relative positions
    resolveDoppel(threadId)                       exact key only
      -> compatible extension                     reuse (or resolve pending MCP handlers)
      -> edited/compacted history                  rebuild from supplied history
      -> unknown key with history                 import history into a new doppel
      -> unknown key without history              clean-start
      -> same key already streaming               conflict; never infer a fork
    planTurn / spawn or reuse                     unchanged from today, minus pi
    stream SDK messages
      stream_event -> yield RawMessageStreamEvent
      tool_use from MCP handler -> yield block; on message_delta emit stop_reason: tool_use; keep handler pending
  encodeSSE(events) -> response
  on premature disconnect -> signal.abort() -> query.interrupt() -> settleInterruptedQuery
  on normal tool-use response completion -> keep query and handlers alive
```

### Tool round trip

```txt
turn N   : model calls mcp__client__shell_command -> MCP handler blocks on a promise
           daemon yields tool_use block, message_delta{stop_reason: tool_use}, message_stop, ends SSE
client   : executes shell_command, sends turn N+1 with history + tool_result (its own tool id)
turn N+1 : extract same thread ID -> validate history -> reuse
           map returned assistant tool calls to SDK calls by canonical call position
           resolve each tool_result through its client tool_use_id, not result-array order
           resolve promises -> model continues on the same warm query
```

### Compaction (Amp-initiated)

```txt
request K   : history H + user "[inserted by Amp] write a handoff summary…"   -> reuse (one user turn appended)
              model writes the summary as a normal turn on the warm query; cache hit on H
request K+1 : same thread ID, history = [summary as user turn] + retained tail
              -> rebuild that doppel from the new authoritative history
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

### 3. Require the Amp thread marker; validate history within that key

V1 supports Amp requests containing exactly one complete system-text line matching `^Amp Thread URL: https://ampcode\.com/threads/(T-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\r?$` with multiline matching. Scan every system text block, not a fixed array index. Reject missing and duplicate matches, even duplicates of the same ID. Never infer identity from user content, other UUIDs, or history similarity. The API key authenticates the owner; the marker selects a conversation.

Within that key, validate client history against previously emitted content. Ignore `cache_control` placement and normalize renamed tool IDs through assistant call positions. Resolve results via the client IDs, so parallel result ordering cannot cross-wire calls. A history edit triggers rebuild even when message counts match.

### 4. Forks become doppels

An Amp fork with a new thread ID gets its own doppel, importing the history Amp supplies. A changed history with the same ID rebuilds that doppel. Overlapping requests on one ID are conflicts, not evidence of a fork. `forkSession` optimization is deferred; it is not needed for correctness or identity. Verify Amp's actual fork marker before claiming support for the app's fork workflow.

### 5. Every HTTP conversation is a warm host

Design 03's host/guest/ephemeral split is pi identity. Here every conversation wants the warm query, and none can be told apart by kind. One kind, with an idle deadline aligned to the cache TTL (one hour on subscription) and an LRU cap on concurrent processes. Pending MCP handlers wait until the deadline; a request after that rebuilds. Design 03 deferred the idle deadline until a consumer materialized. This is it.

### 6. System prompt passes through as one string, bytes preserved

Amp sends multiple system text blocks whose per-block cache directives Claude Code manages itself. Preserve the block text and join with a fixed newline separator. The SDK accepts one custom system string. Changed instructions must invalidate reuse rather than silently retain an old snapshot. Description relocation prepends its block as it does today; `insertRelocatedToolBlock` already falls back to prepending when its pi anchor is absent. No Amp prompt replacement rules are assumed.

### 7. Tools load upfront

`alwaysLoad` (or `ENABLE_TOOL_SEARCH=false`), not tool search deferral. Amp's prompt assumes the model sees every tool; Amp's own deferral is client-side (`tool_search` plus `code_exec`) and invisible on the wire. The tool set is identical across a thread, so the prefix stays stable either way; upfront loading spends prefix tokens once rather than a round trip per first use. Open fact: whether the pi frontend is deferring today. The bridge never sets the knob, so it probably is; measure before flipping it for pi.

### 8. Parameter mapping is one-to-one or nothing

`effort` and supported thinking display map to SDK options. `max_tokens` maps to `CLAUDE_CODE_MAX_OUTPUT_TOKENS` at spawn; changed limits require a rebuild. Reject unsupported demands rather than silently coercing them. `tool_choice: none` removes the tool set. The spike applies this only to HTTP; fixing the pi frontend's separate `maxTokens` claim remains follow-up work.

### 9. The daemon owns retries

Amp surfaces a 529 to the user on the first attempt. pi's retry policy comes from pi's settings manager, which the daemon does not have. The HTTP frontend carries its own retry configuration and applies it before an error reaches the client.

### 10. Public exposure: Worker key check plus Access, both

The API key alone would authenticate correctly. The Access layer is what keeps every unauthenticated packet off the home network and out of the daemon's logs, and the Worker that validates the key and injects the Access service token already exists for cliproxyapi. Reuse the pattern; the daemon's own key check stays as defense in depth.

### 11. `/v1/models` is served

The follow-up capture observed an authenticated `GET /v1/models`; return Models API-shaped data projected from the account probe's supported models. Canonicalize resolved IDs and stable values, filter mutable aliases, and deduplicate while preserving display names. This catalog is for discovery, not admission: Claude Code may omit a still-supported stable model such as Opus 4.6.

## Edge Cases & Failure Modes

- **Client cancels mid-stream (disconnect):** `interrupt()`, then the existing reusability check. The next request's history will end with truncated text and a thinking block without a signature (signatures arrive at `content_block_stop`); the match diverges at that turn and plans `rebuild`, and the rebuilt transcript must drop that partial assistant turn entirely, not trim it, or Fable 5.1's preserved-thinking check rejects it.
- **Two Amp threads open identical conversations:** distinct required IDs select separate doppels from the first request.
- **Client drops thinking blocks from history:** the match still succeeds on text and tool blocks; the rebuild loses thinking. Amp does not do this; log a warning when a client does.
- **Amp compaction:** the summary request is a normal turn; the shorter history rebuilds the same keyed doppel. Validate that the marker survives compaction.
- **Compaction reply contains a tool call:** Amp retries three times then wedges the thread ("Compaction failed"). Claude Code answering a summary prompt with plain text is the normal case; nothing to do beyond not breaking it.
- **Daemon restart:** the in-memory store and doppel map are gone; every conversation rebuilds once on its next request. Thinking survives because the client echoes it.
- **`max_tokens` changes mid-conversation:** rebuild so the next subprocess uses the requested limit.
- **Tool set changes mid-conversation:** the existing live MCP reconciliation; with upfront loading this invalidates the prefix once.
- **Malformed model id:** reject it at the HTTP boundary. A well-formed stable Claude model is forwarded even when absent from the discovery catalog.
- **Pending tool handler abandoned by the client:** idle deadline closes the query; the doppel is dropped; a late request rebuilds.
- **Two hits on the daemon for the same conversation concurrently:** reject the second with a conflict while preserving the first request's lock and state.

## Alternatives

### Translate Messages API requests into pi `Context` and keep the runtime as is

- **Status:** Accepted for the diagnostic spike only
- **Decision:** Double conversion exercises the existing runtime before committing to extraction. Use one runtime per Amp thread so each has its own warm host. Replace the adapter with the shared Messages-shaped core after live verification; it is not the permanent package boundary.

### Require a conversation key from the client

- **Status:** Accepted for Amp-only v1
- **Decision:** Require the labelled thread URL actually observed in system text. Static configured headers are not needed. If Amp changes that format, fail clearly rather than guessing identity.

### Persist a key-to-session index and resume from Claude Code's JSONL after restart

- **Status:** Open
- **Open issue:** stable Amp thread IDs make indexing possible, but the client history still has to be checked on every resume.
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

Context for the implementer: `createBridgeRuntime` (`src/bridge-runtime.ts`) exposes native `turn(request)` and explicit imported-result `replay(request)`. `createPiBridgeRuntime` (`src/pi-runtime.ts`) owns the Pi `stream(model, context, options)` adapter. Sources remain in `src/`; no package moves have happened. Tests cover both frontends against fake SDK queries in `tests/lib/`. Integration tests spend real subscription quota; run deliberately. The user manages git staging personally.

- [x] Phase 0: Record Amp's wire behavior
  - Goal: Know what the client sends before designing for it.
  - Files: `diag/amp-recorder/server.mjs`, `diag/amp-recorder/README.md`, `diag/AMP-WIRE-BEHAVIOR.md`.
  - Work: done 2026-09-15; findings above.
  - Validation: the findings file.

- [x] Phase 1: Amp-only HTTP spike against the existing runtime
  - Goal: Verify identity, streaming, warm tool continuation, and isolation before extracting packages.
  - Files: `diag/http-spike/`, `tests/unit-http-spike.ts`, explicit imported-tool-result replay in `src/bridge-runtime.ts`.
  - Work: require exactly one labelled Amp thread URL; one warm runtime per key; TypeBox validation; authenticated Messages SSE and model listing; map renamed tool IDs without depending on result order; rebuild on changed history or spawn settings. Log sync decisions and usage, never raw requests or credentials.
  - Validation: offline boundary and real-runtime mock tests; two interleaved live Amp threads with distinct tool results and nonzero cache reads. A direct HTTP harness is supporting evidence, not a substitute for Amp end-to-end verification.

- [x] Phase 2: Conversation lifecycle
  - Goal: Verify divergence, cancellation, cold tool-result replay after restart, and new-key history import.
  - Work: rebuild within a key; reject concurrent requests for that key; keep handlers alive after normal tool-use response completion; clean up on cancellation/shutdown. Add idle eviction before persistent deployment.
  - Validation: asymmetric parallel tool-result tests; edited histories with unchanged lengths; restart while a tool is pending; live Amp compaction and fork, checking the marker each time. Do not infer a fork from shared history.
  - Evidence: `diag/http-spike/live-lifecycle.ts` passed pending-tool server replacement, isolated branch recall, shortened-history import, and mid-stream cancellation recovery against Opus 4.6, including the production package on 2026-09-19. Transcript assertions verify discarded history is absent. Idle eviction and cold replay after eviction have offline regression coverage. Deployed Amp conversations subsequently passed graceful restart, idle SIGKILL with explicit start, and actual automatic compaction with tool continuation; see `diag/http-spike/README.md`. The owner waived UI fork verification on 2026-09-19 because no fork action was exposed; this closes the release criterion, not a passing UI fork test. In-flight crash and automatic restart policy remain untested.

- [x] Phase 3: Core contract in Messages API shapes
  - Goal: `runtime.turn()` takes `{key, model, system, messages, tools, effort, thinkingDisplay, maxOutputTokens, signal}` and yields raw stream events; pi conversion lives at the edge. No behavior change for pi.
  - Files: `src/bridge-runtime.ts`, `src/doppel.ts`, `src/query-state.ts`, `src/provider-stream.ts`, `src/core-response.ts`, `src/runtime-request.ts`; Pi boundary in `src/pi-runtime.ts`, `src/pi-response.ts`, `src/pi-usage.ts`, `src/convert.ts`, and `src/turn-plan.ts`.
  - Work: define the contract; move pi-message reading into the adapter, which builds `messages` and resolves tool results before calling `turn()`; the cursor counts Messages API messages; system-prompt rewriting stays in the adapter; `key` replaces direct `options.sessionId` reads inside the runtime. Keep the low-level MCP `Server` and blocking handlers as they are.
  - Validation: `mise run check`; existing unit suite green with the harness updated to build Messages API inputs; one live pi smoke turn with tools.
  - Implemented: native input, sync/import/cursors, query response state, and stream output. A transitive dependency test excludes Pi imports from core. HTTP uses the native contract directly. Pi retains returned messages until command accounting completes, then releases them; fallback-model costs use the requested model's metadata and SDK's authoritative costs. Pre-content retry remains invisible; non-tool success waits for the SDK result, while tool handoff completes immediately.
  - Evidence (2026-09-19): offline checks passed; the live Opus 4.6 HTTP lifecycle diagnostic passed all four scenarios. A Pi CLI Haiku smoke executed `read("package.json")`, returned `pi-doppelclaude`, and recalled it on a second turn. This caught and fixed double-qualified MCP registration that direct-core mocks had missed. Package moves are deliberately deferred.

- [x] Phase 4: Workspace split
  - Goal: `packages/doppelclaude`, `packages/pi-doppelclaude`, `packages/http-doppelclaude`, root `workspaces`.
  - Files: `package.json`, `packages/*/package.json`, `tsconfig*.json`, `biome.json`, `mise.toml` tasks, `hk.pkl`, CI workflow, `DEV.md`.
  - Work: move core sources and the fake-SDK test harness into core; pi adapter and `index.ts` into the pi package; keep the published name `pi-doppelclaude`; confirm `pi install npm:pi-doppelclaude` resolves core from npm (publish core first, or use a workspace-aware pack for the check).
  - Validation: `mise run check` at root; packed tarballs install in a clean directory and resolve their built exports. The packed Pi extension passed a live Haiku file-read and second-turn recall; the packed HTTP CLI passed startup authentication/cap probing and two concurrent Opus 4.6 tool conversations.

- [x] Phase 5: Replace the diagnostic adapter with the HTTP package
  - Goal: Keep the verified HTTP contract while removing the temporary Pi round trip.
  - Work: move validation, identity extraction, and SSE encoding into the HTTP frontend; use the shared core directly; add daemon configuration, idle limits, and bounded retry behavior. Keep unsupported request semantics explicit.
  - Validation: repeat the spike and lifecycle predicates against the package, plus the existing Pi regression suite.
  - Implemented in `packages/http-doppelclaude`: validated environment configuration; loopback CLI; startup subscription check and description-cap probe; shared relocation; bounded idle/LRU admission, requests, retries and shutdown; immediate SSE headers and keepalives; private state directory; credential-safe errors. Structured 429/529 metadata gates retries before output. The repository-owned image supersedes the earlier standalone tarball export protocol.

- [x] Phase 6: Repository-owned daemon image
  - Goal: deployment consumes an immutable application image and owns only secrets, networking,
    init, writable state, and service lifecycle.
  - Implemented: pinned Node 24 Linux/amd64 image, UID/GID 3456, no Caddy or supervisor, writable
    state under `/var/lib/doppelclaude`, and a daemon exec entrypoint. GitHub Actions builds and
    smoke-tests one image; trusted protected-main and `v*` pushes archive and publish that exact
    image under distinct main/release SHA tags and, for releases, a version tag. Deployment pins
    the resolved digest. Publishing uses only `GITHUB_TOKEN`.
  - Validation: CI checks non-root execution, CLI startup, missing credentials, absence of Pi runtime
    dependencies, and operation with a read-only root plus writable state and `/tmp`.

Historic deployment preparation in ansiblonomicon included a Node/Caddy image assembly. That plan
predated the repository-owned image and is superseded; ansiblonomicon now only consumes an
immutable image and configures infrastructure around it.
