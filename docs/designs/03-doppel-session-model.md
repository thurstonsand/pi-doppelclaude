# Doppel Session Model

## Status

Accepted

## Decision Summary

Every provider call runs in a **doppel** — the Claude Code counterpart of one conversation — keyed by the pi session id the caller sends, or a synthetic key when it sends none. The single global `{sharedSession, rootContext}` pair becomes a map of doppels; classification of "whose conversation is this?" moves from history-shape heuristics to caller identity. The tradeoff: guests and ephemerals give up warm-process reuse (respawn per turn) in exchange for a model with no special cases and no cross-conversation interference.

## Problem Statement / Background

The bridge historically held one shared session and one root query context, and decided "is this call the main conversation?" by asking "is the root context free?" Those are different questions, and the gap produced three field failure classes:

- **Mutual force-close.** A working-vibe query (1 message, no tools, sonnet) landed on an idle root, drain-closed the warm persistent query, and collided with the user's real turn arriving 40ms later. The two spawns force-closed each other's queries; the SDK's `Query closed before response received` rejection landed on the shared context, consumed the real turn's retry, and surfaced as a show-stopping error (bridge log 2026-08-02T00:54:12).
- **Warm-session destruction.** Even without a collision, every auxiliary call that claimed the root destroyed the persistent query — a full resync and prompt-cache loss on the next real turn.
- **Session-start clobber.** The interim fix (the `side-start` sync path) classifies side queries as "context shorter than the live shared session's cursor." During the first turn no cursor exists yet, so an auto-title call classifies `clean-start`, owns the session, and writes its 1-message transcript as `sharedSession`; the first real turn rebuilds it back.

The length heuristic also conflates a side query with a genuinely rewound conversation (pi `/undo`), degrading rewinds to permanently cache-less one-shots.

Verified caller facts (pi v0.83.0, this machine): pi's main agent loop passes `options.sessionId` (the pi session UUID) on every turn; working-vibes passes `{apiKey, headers, env, signal}`; auto-title passes `{maxTokens, reasoning, signal}` — neither carries a session id. Compaction never enters turn classification (separate `session_before_compact` hook).

A near-future consumer sharpens the requirement: an in-process background conversation (e.g. pi-librarian) would today ping-pong `rebuild`s against the interactive session over the single shared-session slot.

## Goals

- One classification rule for every caller, based on identity, with no main-vs-side special cases in lifecycle code.
- Concurrent conversations in one process cannot interfere with each other's sessions, queries, streams, or retries.
- Auxiliary keyless calls (title, vibe) leave zero residue: no session state, no process, no store entries.
- A rewound conversation rebuilds instead of degrading to cache-less one-shots.
- The interactive session keeps today's warm persistent-query behavior exactly.

## Non-Goals

- Idle-deadline warmth for guests. v1 reconstitutes guests every turn; a deadline knob is future work if a long-running in-process guest materializes.
- Cross-process doppel coordination. The bridge owner is process-scoped; separate pi processes remain fully independent.
- Persisting doppel state across process restarts.
- A cap on concurrent ephemerals.

## Exposed Shape

- **pi → bridge**: `options.sessionId` (already in pi's `StreamOptions`) is consumed once at the edge of `streamClaudeAgentSdk`. Present → the call addresses the doppel with that key. Absent → a synthetic key; the doppel is ephemeral.
- **host designation**: `designateHost(piSessionId)` on the runtime's surface. `src/index.ts` calls it from the `session_start` event; the test harness calls it directly. `session_shutdown` tears down the host doppel.
- **Doppel** (internal contract): `{ key, session, context, kind: host | guest | ephemeral }` in a `Map<key, Doppel>`. All existing per-conversation machinery — sync planning, reuse/rebuild, retry-once, reentrant contexts, MCP reconciliation — operates on one doppel and never reads another's state.
- **Claude Code**: host keeps a persistent `query()` across turns; guests get `query()` per turn resumed from the in-memory SessionStore; ephemerals get `query()` per turn and leave no store residue (see the `persistSession` edge case below).
- **Failure behavior**: a doppel's failure (dead query, 401, force-close) is reported on that doppel's stream and can only mark that doppel's session for rebuild.

## Design Decisions

### 1. Identity classifies; history-shape does not

`options.sessionId` decides which doppel a call addresses. The length heuristic is deleted. Within a keyed doppel, shorter-than-cursor is a rewind and plans `rebuild`. This fixes the session-start clobber (a keyless title call can never own any conversation's session) and the `/undo` degradation in one move.

The `side-start` sync path is deleted outright, not renamed. It existed only because classification and sync planning were entangled through one global session — the planner had to infer "this is not my conversation" from history shape. Per-doppel planners only ever see their own history, so the paths return to `reuse` / `rebuild` / `clean-start`; an ephemeral doppel's turn is simply `clean-start` in an empty doppel.

### 2. One doppel map replaces the global pair

`sharedSession` and `rootContext` as module-level singletons are the root cause of every cross-conversation interference bug this repo has patched (upstream's "Preserve shared session across synthetic contexts", our `side-start` isolation). The map makes interference structurally impossible rather than guarded against.

### 3. Lifecycle is determined by identity: host / guest / ephemeral

- **Host** (the pi session hosting this process): the only warm persistent query. Identity comes from `session_start` — no config, no first-caller heuristic.
- **Guest** (any other pi session id): shared session and transcript retained; query closed at turn end and reconstituted (respawn + SessionStore resume) next turn. Chosen deliberately for v1: most guests are expected to be run-once, and a warm process per abandoned guest is a leak and a stale-credential 401 racer.
- **Ephemeral** (no session id): everything discarded at turn end. Deadline-zero is not policy but fact — nothing can ever address it again.

### 4. Statelessness stays rejected

Upstream spiked one-query-per-turn for everything and abandoned it: the Agent SDK blocks external tool_result injection, so multi-turn tool flows require a live query. Unification happens at the doppel layer, not by making every call a one-shot.

## Edge Cases & Failure Modes

- **Keyed call arrives before `session_start` designates the host:** treated as a guest; if it later proves to be the host's id, the host designation upgrades the existing doppel in place — no state loss.
- **Reentrant call on the same doppel (steering mid-turn):** existing reentrant QueryContext machinery, now scoped per doppel.
- **Dead-query retry:** unchanged; `turnRetry` already lives on the QueryContext, which belongs to exactly one doppel.
- **Guest resume when the store entry is gone** (process restarted between guest turns): plans `rebuild` from the caller-provided context — same path as any diverged history.
- **Ephemeral failure:** reported on its own stream; the doppel is discarded either way.
- **`persistSession: false` constraint:** incompatible, verified against the vendored SDK. `Options.sessionStore` (sdk.d.ts): "Cannot be used with persistSession: false -- local writes are required for the mirror to function (the mirror hook fires after local write success)." The bridge mirrors every query into its in-memory SessionStore, so ephemerals keep the mirror and take the create-then-delete path: the doppel leaves the registry when its query closes, and that close deletes both its store entry and its local session fragment.

## Alternatives

### Uniform idle deadline for all keyed doppels

- **Status:** Rejected (for v1)
- **Decision:** The host stays warm by identity, not by timer. Most guests are run-once; a deadline keeps their processes alive for nothing, and choosing the value is speculative without a real long-running guest to measure.
- **Discussion:** Remains the natural extension if in-process background conversations with rapid turn cadence appear; the doppel map makes adding a per-kind deadline trivial.

### Length heuristic as classifier (status quo, `side-start`)

- **Status:** Superseded by this design
- **Decision:** Requires an established cursor to compare against, so it misfires during the first turn, and it cannot distinguish a side query from a rewind.

### Fully stateless: one query per turn for everyone

- **Status:** Rejected
- **Decision:** Upstream validated the architecture in a spike and abandoned it — the Agent SDK does not accept externally injected tool_results, so tool-using turns need the live query's MCP callback channel.

### Configured or first-caller "main" marker

- **Status:** Rejected
- **Decision:** `session_start` already names the hosting session; configuration would be a second source of truth and first-caller ordering is a race.

## Implementation Plan

Context for the implementer: `createBridgeRuntime` (src/bridge-runtime.ts) currently holds closure state `sharedSession` (one `SessionState | null`) and a root `QueryContext`, with `planSharedSessionSync` / `applySharedSessionSync` / `closeQueryContext` / `discardQuery` / `retryDeadQuery` / `failQuery` / `spawnFreshQuery` / `consumeQuery` all reading or writing that pair. `QueryContext.ownsSharedSession` (src/query-state.ts) currently gates the writes. The unstaged tree also carries the `side-start` sync path; this plan deletes it. The `canPush` persistent-reuse branch in `beginTurn` is an optimization over the general fresh-spawn-with-resume path (`resume=<sessionId>`), which already exists and is what guests use per turn.

- [x] Phase 1: Identity classification and host designation
  - Goal: Classification by `options.sessionId` instead of history shape; `side-start` deleted; rewind plans `rebuild`. No doppel map yet — keyed non-host and keyless calls both run the existing isolated one-shot path, so guests temporarily behave as ephemerals.
  - Files: src/bridge-runtime.ts, src/index.ts, src/query-state.ts, tests/unit-side-query.ts (rewrite), tests/unit-sync-shared-session.ts, tests harness helpers.
  - Work:
    - Add `designateHost(piSessionId: string)` to the runtime's returned surface; `src/index.ts` calls it from the existing `session_start` handler. Store `hostSessionId` in runtime closure. Re-designation with a new id (pi `/new` or `/resume` in the same process) drains the old host's persistent query via the existing `closePersistentQuery` path before switching.
    - In `beginTurn`: read `options.sessionId`. `isHost = sessionId === hostSessionId`; keyless or non-host → the isolated reentrant path (today's `isSideQuery` treatment, renamed; `ownsSharedSession = isHost`). Fail fast if a turn arrives before any host designation AND carries the host's shape — concretely: keyed pre-designation calls run isolated (guest-as-ephemeral is Phase 1's accepted degradation; Phase 2 upgrades them in place).
    - Sync planner: delete the `side-start` branch and `SyncPath` member entirely; restore the `priorMessages.length < cursor` case to `rebuild` (rewind). Only the host's turns consult `sharedSession` in Phase 1.
    - Delete the length-based comment block that justified `side-start`; the identity comment replaces it.
    - Test harness: default `options.sessionId` to a fixed host key and call `designateHost` with it at setup, so existing main-turn tests keep their semantics untouched; classification tests override with a foreign key or omit it. Rewrite tests/unit-side-query.ts assertions from "shorter context" setups to "keyless caller" and "foreign key" setups; keep all four isolation invariants (idle root untouched, no collision, failure containment, sharedSession invariance) — they are the regression net for the field bugs.
  - Validation: `mise run lint`; `npm run test:unit` green; live smoke `pi -ne -e ./src/index.ts -p --model doppelclaude/claude-haiku-4-5 'Reply with exactly: bridge-ok'`; with debug on, a vibe/auto-title call in a live session logs the isolated path while the warm query survives.

- [x] Phase 2: The doppel map
  - Goal: `Map<key, Doppel>` replaces the global `{sharedSession, rootContext}` pair; guest state survives across turns via reconstitution; ephemerals leave no residue.
  - Files: new src/doppel.ts, src/bridge-runtime.ts, src/query-state.ts, src/index.ts, new tests/unit-doppel-lifecycle.ts.
  - Work:
    - `src/doppel.ts`: `createDoppel({ key, kind })` factory owning `{ sharedSession, queryContext }` per house style (explicit deps, no globals). `kind: "host" | "guest" | "ephemeral"`. The runtime holds `Map<string, Doppel>` plus `hostSessionId`; ephemerals get a synthetic key (`crypto.randomUUID()`) and are removed from the map at turn end.
    - Move every `sharedSession` read/write and the root-context selection into doppel scope. The functions listed in the context note above take the doppel (or live on it); after this, `QueryContext.ownsSharedSession` is deletable — a context always owns its own doppel's session, and retention is decided by `doppel.kind`, not by a flag. Delete it.
    - Guest lifecycle: at turn end (terminal stream event), close the guest's query via the existing drain path but keep the doppel entry; next turn plans `reuse` against its retained `sharedSession` and takes the fresh-spawn-with-resume path. Host keeps `canPush` persistent reuse exactly as today. Pre-designation keyed doppels upgrade to host in place when `designateHost` matches their key.
    - Ephemeral lifecycle: pass `persistSession: false` in query options; verify against the SDK (the manifest hints at a session-mirroring constraint — if `persistSession: false` breaks the in-memory SessionStore mirroring the bridge depends on, fall back to today's create-then-delete and record that in the design doc's edge cases). Remove the doppel and any store records at turn end regardless.
    - `session_shutdown`: close every doppel — host via drain, others force. `session_start` with a different id: previous host demotes to guest (state retained, query closed).
    - Retry interplay: `turnRetry` stays on the QueryContext; a replay re-resolves the same doppel by key. No changes to src/dead-query.ts.
    - tests/unit-doppel-lifecycle.ts: (a) guest turn → query closed at turn end, doppel retained → second guest turn plans `reuse` with `resume`; (b) ephemeral turn leaves map and store empty; (c) two keyed conversations interleaved — host and guest — with zero cross-writes to each other's sharedSession (the librarian ping-pong regression); (d) host re-designation demotes and drains; (e) pre-designation guest upgraded in place.
  - Validation: `mise run lint`; `npm run test:unit` green; live smoke as Phase 1 plus `syncResult` log lines carrying doppel kind and key; grep the bridge log for absence of `WARNING: currentPiStream overwritten` during vibe + turn overlap.
  - Note: keep src/bridge-runtime.ts from growing — the doppel extraction should shrink it; if it grows past the current line count, extract further rather than sprawl.

- [x] Phase 3: Flip the vocabulary and validate in the field
  - Goal: Logs, docs, and CONTEXT.md speak doppel; design accepted on field evidence.
  - Files: CONTEXT.md, DEV.md, src debug strings, tests/int-smoke.sh (grep patterns only if touched), docs/designs/03-doppel-session-model.md.
  - Work:
    - Debug lines: `syncResult: path=<reuse|rebuild|clean-start> doppel=<kind>:<key8>`; retire `Case N` prefixes only if the user agrees (they have diagnostic continuity value — ask, do not assume).
    - CONTEXT.md: sync-paths entry loses the `side-start` clause; Doppels section stands as written. DEV.md project structure gains src/doppel.ts — propose to the user, who prunes doc churn deliberately.
    - Run one real session with working-vibes and auto-title active for a day; confirm in the bridge log: ephemeral doppels for both callers, zero mutual force-closes, zero spurious rebuilds at session start. Then flip this doc to Accepted.
  - Validation: `mise run lint`; `npm run test:unit`; the field log review above.

Handoff rules that are not in the code: the user manages git staging personally — never `git add`/`stash`/`restore`; integration tests burn real subscription quota — do not run them without being asked; hk pre-commit prettier-formats on commit, so line counts measured pre-commit differ from committed ones.
