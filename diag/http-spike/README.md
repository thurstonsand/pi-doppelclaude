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

Offline tests cover strict identity extraction, interleaved and reversed parallel tool results, history divergence, overlap rejection, disconnect/rebuild, and cold/rebuilt tool-result replay through the real runtime with a mocked SDK. At this stage, live Amp fork, compaction, cancellation, and restart recovery were unverified and deployment was pending. Later verification is recorded below.

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

These are loopback HTTP tests against the real SDK, not Amp UI tests. Server replacement clears all bridge state but runs in the same Node process; it is not an OS-level crash test. Actual Amp fork/compaction marker behavior and hard-crash recovery were not exercised by this diagnostic. Idle eviction has offline regression coverage.

### Native core extraction (2026-09-19)

The HTTP diagnostic calls the Messages-shaped core directly. It no longer constructs Pi contexts or translates Pi output back into SSE. The Opus 4.6 lifecycle command passed all four scenarios on this path. Pi's separate CLI smoke on Haiku executed a real file-read tool and recalled the result on a second turn. Offline checks cover the native completion boundary: successful non-tool streams wait for the SDK result, errors never emit a successful `message_stop`, and tool handoffs close without waiting for command completion.

The production implementation now lives in three packages: `doppelclaude`, `pi-doppelclaude`, and `http-doppelclaude`. Shared description relocation, idle eviction, bounded retries, configuration, startup authentication, SSE heartbeats, and shutdown are implemented. These diagnostics exercise that package directly. Packed HTTP and Pi installations passed live tool/recall smoke tests. The daemon-only image built and passed read-only/non-root checks; a live same-thread Haiku 4.5 to Opus 4.6 switch retained history. See `packages/http-doppelclaude/README.md` for the runtime contract.

### Deployed Amp conversations (2026-09-19)

The [image workflow](https://github.com/thurstonsand/pi-doppelclaude/actions/runs/35427699682) passed 360 tests, built and smoke-tested the image, and published that exact image. Ansiblonomicon deployed `ghcr.io/thurstonsand/http-doppelclaude@sha256:9a331e12403131beba31f903d0bedab07b26b193b717e3840d75d75a95e6f8c7` on pod042 behind `https://doppelclaude.thurstons.house/v1`. The personal Amp connection uses `doppelclaude/*`; no other provider was changed.

Two actual Amp orb threads ran the normal high-mode prompt and full tools with `doppelclaude/claude-opus-4-6`, four user turns each:

- [Coding conversation](https://ampcode.com/threads/T-01a0b87a-f35d-71c9-bcbc-36585c1be1de): built a ledger CLI, revised its behavior, and passed 20 tests plus real positive/negative CLI invocations. The parent independently downloaded the implementation and reran the tests with additional assertions.
- [Isolation conversation](https://ampcode.com/threads/T-01a0b87b-642e-74cd-b50d-239a10806fc3): executed shell calculations and retained its own nickname and balances, distinct from the coding thread.

After both threads finished their second turns, only the dedicated container was restarted. Host inspection confirmed a new daemon PID and no surviving Claude subprocesses. Both original threads then completed their third turns with correct memory and tool execution. The coding thread returned `{"__proto__":5,"delta":499,"zero":0}` and passed all 20 tests again; the isolation thread correctly continued from 500 to 533 cents. Amp usage records reported `claude-opus-4-6` throughout and 43,884 cached input tokens on the coding thread's second user turn.

The dedicated container was subsequently killed with SIGKILL while both threads were idle, then explicitly started. Host inspection recorded exit 137, no OOM, new daemon/init PIDs, no surviving Claude children, and unchanged image/configuration. Both original threads completed a fourth turn: the coding thread passed 20 tests and returned `{"__proto__":13,"beta":62,"zero":0}` for fresh input; the isolation thread recalled 533 cents and applied a 28-cent refund to reach 505, still excluding its pending invoice.

This verifies the deployed route, multi-turn tool execution, independent conversation state, and cold reconstruction after both graceful restart and idle SIGKILL with explicit start. It does not verify automatic restart policy or an in-flight crash.

### Actual Amp automatic compaction (2026-09-19)

A [dedicated Amp thread](https://ampcode.com/threads/T-01a0b895-8857-734d-8572-70f305f16f98) used the same deployed Opus 4.6 route and full tools, with `compactionThresholdTokens: 40000`. A large generated tool result triggered automatic compaction. The parent inspected the exported thread: it contains two actual `info`/`summary` checkpoints, and subsequent requests completed through the provider. Reported input dropped from 64,297 to 37,993 tokens.

On a subsequent user turn, the agent recalled its conversation-only project, Vermilion Otter, and 731-cent balance; applied a 46-cent refund; and verified 685 cents with a shell tool. The 8100-cent pending invoice remained excluded. No file or other thread supplied these facts. This verifies actual Amp automatic compaction and post-compaction tool continuation, rather than only synthetic shortened-history import.

Remaining verification limits: the browser UI fork action could not be exercised because the orb browser lacked an authenticated Amp UI session. The owner subsequently waived it as a release criterion because no fork action was exposed in their UI; removal of the feature is not independently confirmed. New-key history import and branch isolation passed the direct SDK diagnostic, but that does not prove UI fork marker behavior. In-flight crash, automatic restart policy, and an isolated multi-minute heartbeat/cancellation measurement remain untested. Temporary test-agent tooling was removed after verification.
