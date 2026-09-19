# Amp HTTP spike

Diagnostic Anthropic Messages-compatible frontend. It supports authenticated `GET /v1/models` and
streaming `POST /v1/messages` with requester-selected models. Authentication may use `x-api-key` or
`Authorization: Bearer`; keys must be nonblank. Message requests require exactly one
`Amp Thread URL:` line in system text.

```sh
DOPPELCLAUDE_HTTP_API_KEY='local-secret' npm exec doppelclaude-serve
# Or avoid putting the key in the environment value itself:
DOPPELCLAUDE_HTTP_API_KEY_FILE="$HOME/.config/pi-doppelclaude/http-key" \
  npm exec doppelclaude-serve
AMP_THREAD_URL='https://ampcode.com/threads/T-...' \
  DOPPELCLAUDE_HTTP_API_KEY='local-secret' diag/http-spike/smoke.sh
# Deterministic two-thread tool continuation and warm-reuse diagnostic:
DOPPELCLAUDE_HTTP_API_KEY_FILE="$HOME/.config/pi-doppelclaude/http-key" \
  node --import tsx diag/http-spike/live-direct.ts
# Synthetic lifecycle checks over fresh in-process loopback servers (uses live subscription quota):
node --import tsx diag/http-spike/live-lifecycle.ts
```

Set diagnostic client variable `DOPPELCLAUDE_HTTP_CLIENT_MODEL=claude-opus-4-6` (or `claude-opus-5`) on client commands to use Opus. This does not configure the server.
Requests may name the model directly or as `<provider>/<model>`. The spike accepts Amp's adaptive thinking and effort,
maps effort to the bridge reasoning level, and applies `max_tokens` to the Claude Code child.

Limitations: only SSE is supported; temperature and unsupported Anthropic content semantics are
rejected; state is in-memory and bounded to 32 threads; each thread permits one active request;
complete tool-result sets are required before continuation. The standalone server defaults
to loopback; the container listens on all interfaces. Tunnel/routing setup is outside this repo.

## Live findings (2026-09-18)

Two real Amp CLI threads reached the server through a temporary personal custom route and Cloudflare quick tunnel. Each called `shell_command`, executed it in Amp, and returned its own token (`ALPHA_17` / `BRAVO_92`). Amp renamed the tool IDs to `TU-…`; continuation still resolved the correct pending SDK handler. Tool follow-ups read 9,797 and 9,801 cached input tokens. Both threads remained allocated while their subsequent user turns ran concurrently.

Thread B's next user turn returned `BRAVO_92` with 9,949 cached input tokens. Thread A's next turn was rejected upstream with an Opus 5 `reasoning_extraction` safeguard error. A separate direct HTTP test encountered the same class of rejection. This is partial end-to-end evidence, not a passing reliability test; the cause of the upstream classification is not established. Amp's CLI exited zero even for its `error_during_execution` result, so inspect the result event rather than only the process exit code.

Offline tests cover strict identity extraction, interleaved and reversed parallel tool results, history divergence, overlap rejection, disconnect/rebuild, and cold/rebuilt tool-result replay through the real runtime with a mocked SDK. Live Amp fork, compaction, cancellation, and restart recovery remain unverified. The production package now adds idle eviction and configurable resource limits; deployment remains pending.

### Direct SDK comparison

`node --import tsx diag/http-spike/compare-continuation.ts` runs the same fixed tool call and subsequent user prompt through native SDK `query()` and then the HTTP bridge. It consumes subscription quota. A loopback forwarding proxy leaves outgoing request bytes unchanged and reports only request structure and hashes; no credentials or raw thinking are written. The JSON report records outcomes, not a pass implied by the command's exit status.

The first comparison reproduced `reasoning_extraction` in both paths on `Repeat the same token exactly.`, after both had answered `ALPHA_17` from the tool. Native SDK reported the rejection text in a result whose subtype was `success`; the bridge surfaced it as an SSE error. The HTTP lane spawned one query and passed exactly the initial prompt and follow-up into it—no transcript replay. Neither lane's captured history contained a thinking block. This reproduction therefore does not require the HTTP adapter, history conversion, or damaged thinking signatures.

This isolates the failure to behavior reachable through native Claude Code/SDK and the upstream service; it does not establish why the safeguard classified this prompt that way, or rule out unrelated bridge bugs. The two outbound histories are not byte-identical: SDK-inserted system messages differ, and system-prompt and tool-block hashes differ. The bridge also adds a leading system-prompt separator. No retry, prompt workaround, or production fix was added. Retain the explicit error and continue lifecycle verification separately.

### HTTP lifecycle verification on Opus 4.6

`node --import tsx diag/http-spike/live-lifecycle.ts` passed all four scenarios on 2026-09-18:

- Closed the server with a pending tool handler, created a fresh server/runtime, and recovered the renamed tool result from client history.
- Imported the same history under another thread ID, diverged the branches, and verified that concurrent later recall returned each branch's own value.
- Replaced a four-message history with a three-message summary-like history. The imported SDK transcript contained the replacement value and excluded the discarded value.
- Aborted after streamed text arrived and before `message_stop`, then recovered. The imported transcript retained the authoritative baseline and excluded the interrupted request.

Cancellation cleanup is asynchronous. An immediate continuation can receive 409 while the old request still owns the thread lock; the diagnostic polls only that status for up to ten seconds. It never retries model/SSE errors. The first live run exposed this expected lock race; subsequent checks also strengthened assertions that could otherwise pass despite stale history.

These are loopback HTTP tests against the real SDK, not Amp UI tests. Server replacement clears all bridge state but runs in the same Node process; it is not an OS-level crash test. Actual Amp fork/compaction marker behavior and hard-crash recovery remain unverified. Idle eviction has offline regression coverage.

### Native core extraction (2026-09-19)

The HTTP diagnostic calls the Messages-shaped core directly. It no longer constructs Pi contexts or translates Pi output back into SSE. The Opus 4.6 lifecycle command passed all four scenarios on this path. Pi's separate CLI smoke on Haiku executed a real file-read tool and recalled the result on a second turn. Offline checks cover the native completion boundary: successful non-tool streams wait for the SDK result, errors never emit a successful `message_stop`, and tool handoffs close without waiting for command completion.

The production implementation now lives in three packages: `doppelclaude`, `pi-doppelclaude`, and `http-doppelclaude`. Shared description relocation, idle eviction, bounded retries, configuration, startup authentication, SSE heartbeats, and shutdown are implemented. These diagnostics exercise that package directly. Packed HTTP and Pi installations passed live tool/recall smoke tests. The daemon-only image built and passed read-only/non-root checks; a live same-thread Haiku 4.5 to Opus 4.6 switch retained history. Public deployment remains pending. See `packages/http-doppelclaude/README.md` for the runtime contract.
