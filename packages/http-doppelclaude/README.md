# http-doppelclaude

Amp-only Anthropic Messages HTTP frontend for doppelclaude (Node 24+). Claude Code owns subscription authentication and model access; Amp owns tools and conversation history. This is a personal proxy, not a service for other users.

```sh
DOPPELCLAUDE_HTTP_API_KEY_FILE=/path/to/private/api-key doppelclaude-serve
```

The standalone daemon listens on `DOPPELCLAUDE_HTTP_HOST` (an IPv4 or IPv6 address literal,
default `127.0.0.1`) and `PORT` (default `3456`). Configure exactly one of
`DOPPELCLAUDE_HTTP_API_KEY` and `DOPPELCLAUDE_HTTP_API_KEY_FILE`. State and debug logs live under
`DOPPELCLAUDE_STATE_DIR` (default `~/.local/state/doppelclaude`). `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_CONFIG_DIR` are inherited unchanged.

Startup creates the state directory with mode `0700`, verifies first-party subscription authentication, and discovers the installed Claude Code tool-description limit and model catalog before opening the socket. Use `claude auth login` or supply `CLAUDE_CODE_OAUTH_TOKEN` through your service's secret manager. API-key authentication to Anthropic is rejected. Startup has a 30-second deadline. The requester chooses the model on every call; the discovered catalog supports client discovery but is not a request allowlist. The `opus` and `fable` aliases are snapshotted at startup. An exact SDK alias row with a stable `resolvedModel` takes precedence; otherwise the catalog must identify exactly one distinct stable concrete model in that family. Restart the daemon after an SDK or container-image refresh to pick up changed alias resolutions. An absent or ambiguous family makes only requests for that alias return 400.

Resource controls are `DOPPELCLAUDE_MAX_RUNTIMES` (32), `DOPPELCLAUDE_IDLE_TTL_MS` (3600000),
`DOPPELCLAUDE_MAX_BODY_BYTES` (32000000, 32 MB), `DOPPELCLAUDE_REQUEST_TIMEOUT_MS` (600000),
`DOPPELCLAUDE_SHUTDOWN_TIMEOUT_MS` (15000), and `DOPPELCLAUDE_RETRY_ATTEMPTS` (2).

The body limit covers the entire JSON request, including base64 images and conversation history. Requests above it return 413 before invoking Claude Code. Claude Code also limits each image to 5 MiB of base64, not decoded bytes. Oversized attachments and tool-result images are re-encoded as WebP at quality 90, fitting within 2000 × 2000 pixels without enlargement, then reduced further only if necessary to meet that encoded-size limit. Smaller images pass through unchanged. This transforms the bridge's request copy, not the client's original attachment or history. Model-specific limits still apply.

Clients call `GET /v1/models` or streaming-only `POST /v1/messages`, authenticating with either
`x-api-key` or `Authorization: Bearer …`. A conversation is keyed by the single Amp Thread URL in
the system prompt. Run `doppelclaude-serve --help` for a no-network configuration summary.

## Amp connection

Expose the listener only through authenticated infrastructure. Configure an Anthropic Messages Custom URL connection in Amp with that public base URL and the daemon API key. Keep subscription credentials on the daemon host; never put them in Amp's connection settings or at the edge.

Conversation requests must include exactly one complete system-text line, except for the bounded one-shot path below:

```text
Amp Thread URL: https://ampcode.com/threads/T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

The ID must be a UUID. Duplicate markers, or a malformed `Amp Thread URL:` label, return 400; shared history never determines identity. Amp currently provides this line automatically. It is an observed client contract, not a guaranteed protocol field.

As a bounded trial exception, a request with no marker is accepted only when it has exactly one user message with nonempty text-only content (a string or text blocks), omits tools or supplies an empty tool list, requests at most 4096 output tokens, and `JSON.stringify({system, messages})` is at most 16384 UTF-8 bytes. Missing `system` is valid. The limits reject the request rather than clamping output or changing thinking. Markerless multi-turn, image, tool, malformed-marker, and oversized requests return 400 before Claude Code is invoked. This exception supports small one-shot work such as title generation; it does not identify or persist a conversation.

Supported parameters are `system`, `messages`, `tools`, `max_tokens`, adaptive `thinking` or enabled `thinking` with a `budget_tokens` integer of at least 1024 (both optionally with summarized display), `output_config.effort`, and `tool_choice: auto|none`. Each request must select a stable Claude model ID or the `opus` or `fable` alias, either bare or provider-qualified. The optional provider prefix is removed at the HTTP boundary. Explicit stable IDs, including unadvertised IDs and any date suffix, are forwarded unchanged and are not catalog-allowlisted. Aliases are replaced with their startup-snapshotted concrete IDs before reaching the core. SSE response metadata reports the model served by the SDK, which may be canonicalized or differ from the requested ID. `GET /v1/models` continues to advertise concrete discovered models, not aliases. Temperature, forced tool choice, non-streaming requests, and unsupported content types are rejected. Cache-control metadata is ignored; Claude Code manages caching. Signed thinking and renamed tool IDs survive round trips.

## Lifecycle and failure behavior

Each thread has one warm runtime and at most one active request. Overlap returns 409. Idle runtimes expire after the configured TTL; capacity pressure evicts the least-recently-used idle runtime, never an active one. If all slots are active or closing, admission returns 503. Pending tools count as idle after their response finishes. A later request imports the client history and resumes from its tool results.

Each accepted markerless request receives a unique internal runtime which counts against capacity through execution and cleanup, never evicts a keyed warm runtime, does not retry bridge failures, and is closed after success, error, or disconnect. Markerless requests return 503 when capacity is unavailable. Shutdown also aborts and closes these runtimes. They have no background persistence or reuse.

History edits, shortened histories, and changed spawn settings rebuild within the same thread. Different thread IDs remain isolated even with identical history. Conversation state is in memory: restart recovery depends on Amp sending its authoritative history. The state directory holds probe caches and diagnostics, not a durable conversation index.

SSE headers flush immediately and comment heartbeats run every 15 seconds. Disconnects and request deadlines abort the query. Only structured upstream 429/529 failures retry, at most the configured count, before any assistant output. Refusals, ordinary errors, and failures after output are never replayed. SIGINT/SIGTERM stop admission, abort active work, and bound cleanup by the shutdown deadline; allow at least 20 seconds in the service supervisor for the default configuration.

## Request diagnostics

Normal stderr includes JSON `request_complete` records for authenticated Messages requests admitted to validation. `requestId`, `runtimeId`, `threadId`, timestamps, and duration correlate requests with the retained runtime. Markerless records use a null `threadId`; `requestKind`, anonymous eligibility, context byte size, and declared output limit diagnose admission without logging request contents. `requestedModel` is the validated model name without its provider prefix; `resolvedModel` is the concrete request model; `servedModel` is the SDK-observed model, or `null` when unavailable. Configuration and canonical-history fingerprints expose changes without logging their contents.

`configurationFields` fingerprints the resolved model, prepared prompt, prepared tools, tool choice, effort, thinking, and maximum output tokens separately. `changedConfigurationFields` names differences from the last successful request on that runtime; it is `null` on the first request and `[]` when unchanged. Only field names and hashes are logged, never their values.

HTTP `sync` is `first`, `compatible`, or `rebuild`. It is a history/settings decision, not proof of a warm query or a provider cache hit. `reason`, `historyDiverged`, `signatureChanged`, and `forcedRebuild` explain it. `executions` records `query_created` (an SDK query object, not a PID), `query_reused` (input pushed into the same query ID), or `tool_result_continuation` (results accepted for that query). Creation includes the core sync path and reason category. A compatible HTTP request can still create a new query. Runtime expiry, eviction, and shutdown emit `runtime_close` records.

Successful records include per-response SDK `usage`: `input`, `cache_read`, `cache_creation`, and `output`. Unreported metrics are `null`; reported zeroes remain `0`. These are response metrics, not aggregate command totals or a subscription-quota estimate. A rebuild can still read provider cache. Failures include the stage, safe error category, retryable status, and actual HTTP status (which can be 200 for an SSE error). Marker validation failures include the count, including zero or multiple markers. Logs omit prompts, history, tool arguments, credentials, and raw error text.

SDK `sdk_status`, `sdk_compact_boundary`, and `sdk_result` execution observations distinguish compaction attempts, completed boundaries, terminal reasons, API status, and advertised context/output limits. Failure text is represented only by a hash, character count, and fixed diagnostic keywords; keyword matches are clues, not error classifications. Request records also include message counts, prompt/tool/history character counts, requested output/thinking budgets, and `resizedImages`. History character counts describe the prepared request, include encoded image data, and are not token estimates.

To investigate displacement, run two main turns, one Oracle call, then another main turn in the same Amp thread. Correlate the invocation times with `threadId`, models, configuration fingerprints, query IDs, and cache reads/creation. A main → Oracle → main configuration sequence with new query IDs exposes replacement; cache metrics separately show the observed cache cost. Do not infer the caller's role from its model alone.

## Container image

The repository builds and publishes the daemon-only Linux/amd64 image
`ghcr.io/thurstonsand/http-doppelclaude`. Main pushes publish `main-sha-<full commit SHA>` and
`v*` pushes publish `<version>` plus `release-sha-<full commit SHA>`. Tags can be moved; production
deployments should resolve a reviewed tag and pin the resulting digest. Pull requests build and
smoke-test without publishing, and CI publishes the exact archive that passed smoke tests.

The image runs as UID/GID `3456`, exposes port `3456`, binds `0.0.0.0`, and uses
`/var/lib/doppelclaude` for `HOME`, state, and logs, with `CLAUDE_CONFIG_DIR` at
`/var/lib/doppelclaude/.claude`. Mount the state directory writable
and provide `/tmp` as writable when the root filesystem is read-only. The deployment must provide
an init and pass secrets at runtime. It must not bake credentials into the image. Override
`DOPPELCLAUDE_HTTP_HOST` if the container should not listen on every interface.

## Build and smoke-test locally

From the repository root:

```sh
mise run check
docker build --build-arg VERSION=1.2.3 -t http-doppelclaude:local .
scripts/smoke-http-image.sh http-doppelclaude:local
```

The multi-stage build compiles the core and HTTP workspaces, updates workspace versions in a copy
of the repository lockfile, and installs only their pinned production dependency graph. The smoke
test requires no live credentials: it verifies the CLI and dependency surface, expected credential
failures, and a mocked-probe HTTP listener with a read-only root filesystem.
