# http-doppelclaude

Anthropic Messages HTTP frontend for doppelclaude (Node 24+), serving Amp and OpenCode from one daemon. Claude Code owns subscription authentication and model access; the client owns tools and conversation history. This is a personal proxy, not a service for other users.

```sh
DOPPELCLAUDE_HTTP_API_KEY_FILE=/path/to/private/api-key doppelclaude-serve
```

The standalone daemon listens on `DOPPELCLAUDE_HTTP_HOST` (an IPv4 or IPv6 address literal,
default `127.0.0.1`) and `PORT` (default `3456`). Configure exactly one of
`DOPPELCLAUDE_HTTP_API_KEY` and `DOPPELCLAUDE_HTTP_API_KEY_FILE`. State and debug logs live under
`DOPPELCLAUDE_STATE_DIR` (default `~/.local/state/doppelclaude`). `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_CONFIG_DIR` are inherited unchanged.

Startup creates the state directory with mode `0700`, verifies first-party subscription authentication, and discovers the model catalog before opening the socket. Use `claude auth login` or supply `CLAUDE_CODE_OAUTH_TOKEN` through your service's secret manager. API-key authentication to Anthropic is rejected. Startup has a 30-second deadline. The requester chooses the model on every call; the discovered catalog supports client discovery but is not a request allowlist. Family aliases are snapshotted at startup for every family the SDK catalog reports a stable `claude-<family>-…` model in, such as `opus`, `fable`, `sonnet`, and `haiku`. An exact SDK alias row with a stable `resolvedModel` takes precedence; otherwise the catalog must identify exactly one distinct stable concrete model in that family. Restart the daemon after an SDK or container-image refresh to pick up changed alias resolutions. An absent or ambiguous family makes only requests for that alias return 400.

Resource controls are `DOPPELCLAUDE_MAX_RUNTIMES` (32), `DOPPELCLAUDE_IDLE_TTL_MS` (3600000),
`DOPPELCLAUDE_MAX_BODY_BYTES` (32000000, 32 MB), `DOPPELCLAUDE_REQUEST_TIMEOUT_MS` (600000),
`DOPPELCLAUDE_SHUTDOWN_TIMEOUT_MS` (15000), and `DOPPELCLAUDE_RETRY_ATTEMPTS` (2).

A turn Claude Code reports as billed to Extra Usage instead of plan limits fails, and the thread's query is retired before Claude Code sends another request. Set `DOPPELCLAUDE_ALLOW_EXTRA_USAGE=1` to keep serving on Extra Usage.

The body limit covers the entire JSON request, including base64 images and conversation history. Requests above it return 413 before invoking Claude Code. Claude Code also limits each image to 5 MiB of base64, not decoded bytes. Oversized attachments and tool-result images are re-encoded as WebP at quality 90, fitting within 2000 × 2000 pixels without enlargement, then reduced further only if necessary to meet that encoded-size limit. Smaller images pass through unchanged. This transforms the bridge's request copy, not the client's original attachment or history. Model-specific limits still apply.

Clients call `GET /v1/models` or streaming-only `POST /v1/messages`, authenticating with either
`x-api-key` or `Authorization: Bearer …`. An OpenCode conversation is keyed by its `X-Session-Id`
header; any other conversation by the single Amp Thread URL in the system prompt. Run `doppelclaude-serve --help` for a no-network configuration summary.

`GET /v1/sdk-models` returns the installed Agent SDK version, capture time, raw SDK model rows
(`value`, nullable `resolvedModel`, and `displayName`), and the alias resolutions used for requests.
The response has `Cache-Control: no-store` and contains no account identity. It is an immutable
startup snapshot: requests do not call the SDK, and SDK/catalog changes require a daemon restart.
It uses the same inference API key and authentication rules as `GET /v1/models`.

## Amp connection

Expose the listener only through authenticated infrastructure. Configure an Anthropic Messages Custom URL connection in Amp with that public base URL and the daemon API key. Keep subscription credentials on the daemon host; never put them in Amp's connection settings or at the edge.

The personal Amp plugin's `doppelclaude.models` command reuses that inference credential from the
Amp personal secret `CLI_PROXY_API_KEY`. A locally run Amp CLI needs that environment variable
injected into its process as well.

A main Amp thread's requests carry exactly one complete system-text line naming the thread:

```text
Amp Thread URL: https://ampcode.com/threads/T-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

The ID must be a UUID. Duplicate markers, or a line opening with a malformed `Amp Thread URL:` label, return 400; the label elsewhere in a line is prose. Marker discovery ignores text inside balanced `<instructions>...</instructions>` regions, including nested or multiple regions, counting only tags that stand alone on their line, as Amp writes its wrappers; a tag named mid-sentence is prose, while the full original system prompt is still sent to Claude Code. This depends on Amp's observed wrapper format rather than a guaranteed protocol field. If any wrapper is unbalanced, filtering is disabled for the entire prompt and normal marker validation applies. Amp currently provides the external identity line automatically.

Amp's subagents (including the Oracle), thread reader, and title generation send no marker, header, or metadata. A markerless request that is exactly one user message with nonempty text-only content (a string or text blocks) and no tools is a one-shot: it runs on its own ephemeral runtime and does not identify or persist a conversation. Any other markerless request is a conversation keyed by a fingerprint of its system prompt and first message, which every later turn of that conversation repeats; its runtimes behave like a thread's. The prompt holds the workspace and the day's date but no per-conversation value, so two conversations from one workspace with an identical first message on the same day share that key. A lane continues only on an exact match of the request's prior history, and a derived key never rebuilds an idle lane that does not continue it, so each such conversation keeps its own warm runtime.

Supported parameters are `system`, `messages`, `tools`, `max_tokens`, adaptive or disabled `thinking`, enabled `thinking` with a `budget_tokens` integer of at least 1024, `output_config.effort`, and `tool_choice: auto|none`. Adaptive and enabled thinking accept `display: summarized|omitted` (or null for the default). Each request must select a stable Claude model ID or a family alias such as `opus`, `fable`, `sonnet`, or `haiku`, either bare or provider-qualified. The optional provider prefix is removed at the HTTP boundary. Explicit stable IDs, including unadvertised IDs and any date suffix, are forwarded unchanged and are not catalog-allowlisted. Aliases are replaced with their startup-snapshotted concrete IDs before reaching the core. SSE response metadata reports the model served by the SDK, which may be canonicalized or differ from the requested ID. `GET /v1/models` continues to advertise concrete discovered models, not aliases.

## Messages compatibility

The daemon adapts Messages requests to the Agent SDK; it is not a transparent Anthropic API proxy. The compatibility audit covers OpenCode's `@ai-sdk/anthropic` path and the [Messages API](https://platform.claude.com/docs/en/api/messages/create), including the AI SDK's [content conversion](https://github.com/vercel/ai/blob/main/packages/anthropic/src/convert-to-anthropic-prompt.ts) and [request options](https://github.com/vercel/ai/blob/main/packages/anthropic/src/anthropic-language-model.ts).

- **User content:** text; images with base64, URL, or file-ID sources; documents with base64 PDF, URL, file-ID, plain-text, or text/image content sources; and `search_result` blocks. Document titles, context, and citation settings are preserved. URL/file sources reach Claude Code unchanged: the daemon does not download them or implement the Files API. Upstream must support the source and the subscription identity must have access to any referenced file.
- **Tool results:** strings, omitted content, or arrays of text, images, documents, and search results. Ordinary text/base64 images use the warm MCP continuation. Documents, URL/file images, citation-bearing text, and images with transformation settings replay the complete authoritative history through the SDK session store instead, preserving content that MCP cannot represent. This costs a query restart on that turn; subsequent turns can reuse the new query. Images inside document content also receive the encoded-size check. `transformations.oversized_image: error` prevents resizing and returns 400 when the encoded image exceeds Claude Code's limit.
- **Assistant history:** text, signed `thinking`, `redacted_thinking`, and client `tool_use`. Thinking signatures and redacted data are retained verbatim in bridge history. Claude Code owns upstream thinking-prefix reconciliation. OpenCode's `thinking.block_binding: {prefix_mismatch_behavior: "drop_block"}` is accepted as an advisory hint, not forwarded as an SDK option; the SDK exposes no binding-policy override. The strict `error` policy is rejected rather than silently weakened.
- **Client tools:** name, description, object input schema, optional `type: custom`, and ordinary client tool results/IDs. `cache_control` (including null) on requests, tools, and nested content is ignored, as is `eager_input_streaming`; Claude Code owns caching and tool-input streaming. These hints do not change tool execution.
- **Deliberately rejected execution features:** server-tool declarations and their history (`server_tool_use`, web-search/fetch, code-execution, tool-search, advisor, and MCP-connector results), `container_upload`, `tool_reference`, and `browser_state`. They require execution/container/toolset state this client-tool bridge does not own. Beta `compaction`/`fallback` blocks and client `context_management` are not imported as ordinary conversation content; clients own history and compaction here.
- **Deliberately rejected request controls:** sampling (`temperature`, `top_p`, `top_k`), stop sequences, forced/parallel tool-choice controls, `strict`, `defer_loading`, `allowed_callers`, and tool input examples. The SDK/MCP path cannot enforce these Messages semantics. Structured `output_config.format`, task budgets, thinking `between_tools`/`updates`, service tier/speed/region, metadata, diagnostics, fallbacks/safeguards, MCP servers, containers, and skills also remain unsupported. Some have SDK counterparts, but need additional response or lifecycle handling rather than schema-only acceptance. Effort levels `low|medium|high|xhigh|max` forward to the SDK. Non-streaming, assistant-prefill, and cache-only (`max_tokens: 0`) requests are rejected.

Invalid unions report the offending block/source path and type instead of the unrelated string branch. Payload text, PDF bytes, and source URLs are not included in validation errors.

MCP can transport a PDF as an embedded resource, but Claude Code 2.1.280 (Agent SDK 0.3.280) saves that blob to disk and gives the model only a text file-location notice, not a native document. `node diag/mcp-pdf-live.mjs` verifies this against a native-document positive control, with native file-reading tools disabled. Re-run on SDK updates; native MCP PDF conversion would let the bridge remove the PDF replay workaround.

The probe also tests resuming a transcript ending in an unanswered tool call and submitting the native PDF tool result as SDK input. CC 2.1.280 removes the unresolved call on load, inserts `No response requested.`, and does not deliver the PDF to the model. Adding `--resume-at-call` tests an explicit `resumeSessionAt` anchor; that fails with `No message found` for the removed call. Neither route currently replaces the complete-history replay and continuation prompt.

Closing a query does not clear Anthropic's prompt cache. A content replay can reuse the unchanged prefix, but transcript reconstruction and the synthetic continuation prompt can change its tail; identical cache hits are not guaranteed. Use the `request_complete.usage.cache_read` and `cache_creation` counters to measure this separately from query reuse.

## OpenCode connection

Add a provider to `opencode.json` using OpenCode's Anthropic SDK package, pointed at the daemon's `/v1` base URL:

```json
{
  "provider": {
    "doppelclaude": {
      "npm": "@ai-sdk/anthropic",
      "name": "doppelclaude",
      "options": { "baseURL": "https://doppelclaude.example/v1", "apiKey": "{env:DOPPELCLAUDE_API_KEY}" },
      "models": {
        "claude-opus-5-5": { "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] } },
        "haiku": { "modalities": { "input": ["text", "image", "pdf"], "output": ["text"] } }
      }
    }
  },
  "model": "doppelclaude/claude-opus-5-5",
  "small_model": "doppelclaude/haiku"
}
```

Declare `modalities` on every model. Without it, OpenCode treats a custom provider's models as text-only and replaces each attached image or PDF with an `ERROR: Cannot read …` note before sending the request, so the daemon never sees the attachment. The provider ID must not start with `opencode`; OpenCode only sends its session headers to other providers. Every request then carries `X-Session-Id: ses_…`, stable across turns and `--session` continuation, and a subagent gets its own session ID. When the header is present it alone identifies the conversation: it must be a `ses_` ID or the request returns 400, and Amp markers in the system prompt are ignored.

OpenCode also sends title generation and compaction under the conversation's session ID. A request that is one text-only user message with no tools runs as a one-shot on its own ephemeral runtime, like a markerless Amp request but without its size limits, so it never displaces the conversation's warm query.

Upstream rejects requests carrying OpenCode's stock environment block as `You're out of extra usage`. The daemon replaces that block's opening line (`Here is some useful information about the environment you are running in:`) with a heading you supply, leaving the block's contents unchanged. As with pi's system prompt replacements, the replacement text lives only in your configuration, never in this repository, so upstream cannot match on it. Set it with `DOPPELCLAUDE_HTTP_OPENCODE_ENVIRONMENT_HEADING`, or put it in a file named by `DOPPELCLAUDE_HTTP_OPENCODE_ENVIRONMENT_HEADING_FILE` (surrounding whitespace is trimmed). Set at most one of the two; a blank value stops the daemon at startup. Without either, OpenCode requests return 400 and Amp is unaffected. If OpenCode rewords the block and the rejection returns, the match is conjunctive: dropping the header, `Workspace root folder`, or `Is directory a git repo` line each cleared it on 2026-09-26.

## Lifecycle and failure behavior

A thread can hold several warm runtimes, each serving one request at a time. A request continues the idle runtime that last served exactly its prior history and settings; otherwise it rebuilds the least-recently-used idle runtime with the same settings, and only opens another runtime when none is idle. So a client's retry of a request it abandoned, or parallel subagents whose prompt and first message are identical, run beside each other instead of failing. Each request record's `lane` field reports `continued`, `reused` or `opened`, and `threadRuntimes` how many runtimes the thread held. Idle runtimes expire after the configured TTL; capacity pressure evicts the least-recently-used idle runtime, never an active one. If all slots are active or closing, admission returns 503. Pending tools count as idle after their response finishes. A later request imports the client history and resumes from its tool results.

Each one-shot receives a unique internal runtime which counts against capacity through execution and cleanup, never evicts a keyed warm runtime, does not retry bridge failures, and is closed after success, error, or disconnect. One-shots return 503 when capacity is unavailable. Shutdown also aborts and closes these runtimes. They have no background persistence or reuse.

History edits and shortened histories rebuild within the same thread; changed spawn settings open or reuse a runtime with those settings. Different thread IDs remain isolated even with identical history. Conversation state is in memory: restart recovery depends on Amp sending its authoritative history. The state directory holds probe caches and diagnostics, not a durable conversation index.

SSE headers flush immediately and comment heartbeats run every 15 seconds. Disconnects and request deadlines abort the query. Only structured upstream 429/529 failures retry, at most the configured count, before any assistant output. Refusals, ordinary errors, and failures after output are never replayed. SIGINT/SIGTERM stop admission, abort active work, and bound cleanup by the shutdown deadline; allow at least 20 seconds in the service supervisor for the default configuration.

## Request diagnostics

Normal stderr includes JSON `request_complete` records for authenticated Messages requests admitted to validation. `requestId`, `runtimeId`, `threadId`, timestamps, and duration correlate requests with the retained runtime. One-shot records use a null `threadId`, and a markerless conversation's is its `derived:` key; `requestKind` (`keyed`, `derived`, `anonymous`, `opencode`, or `opencode_one_shot`) and the declared output limit diagnose admission without logging request contents. `requestedModel` is the validated model name without its provider prefix; `resolvedModel` is the concrete request model; `servedModel` is the SDK-observed model, or `null` when unavailable. Configuration and canonical-history fingerprints expose changes without logging their contents.

`configurationFields` fingerprints the resolved model, prepared prompt, prepared tools, tool choice, effort, thinking, and maximum output tokens separately. `changedConfigurationFields` names differences from the last successful request on that runtime; it is `null` on the first request and `[]` when unchanged. Only field names and hashes are logged, never their values.

HTTP `sync` is `first`, `compatible`, or `rebuild`. It is a history/settings decision, not proof of a warm query or a provider cache hit. `reason`, `historyDiverged`, `signatureChanged`, and `forcedRebuild` explain it. `executions` records `query_created` (an SDK query object, not a PID), `query_reused` (input pushed into the same query ID), or `tool_result_continuation` (results accepted for that query). Creation includes the core sync path and reason category, and for a rebuild, `rebuild` counts what the import changed to match the live prompt: `contextSource` (`own`, `sibling`, or `none`), `contextAttachments` carried, `emptyToolResults` rendered the live way, `sanitizedToolIds`, the tool-pairing repair's `synthesizedToolResults` and `droppedToolResults`, and the replay `turnBoundaries` put back (with `skippedTurnBoundaries` the history no longer lined up with). It also names its `trigger` (`turn`, `dead_query_retry`, `continuation_replay`, `rich_content_replay`, `explicit_replay`) and, for a forced rebuild, `forcedCause`. `compensation` records each recovery the bridge applied by `kind`: `output_ceiling_retired`, `dead_query_retry`, `interrupt_reused`, `interrupt_rebuild`, `session_invalidated`, `unclassified_result`, `unexpected_exit`. `sdk_api_retry` and `model_refusal` record Claude Code's own retries and refusal fallbacks, and `sdk_result` carries that query's own `usage`, so a retried or replaced attempt still shows its cost. A compatible HTTP request can still create a new query. Runtime expiry, eviction, and shutdown emit `runtime_close` records.

Successful records include per-response SDK `usage`: `input`, `cache_read`, `cache_creation`, and `output`. Unreported metrics are `null`; reported zeroes remain `0`. These are response metrics, not aggregate command totals or a subscription-quota estimate. A rebuild can still read provider cache. Failures include the stage, safe error category, retryable status, and actual HTTP status (which can be 200 for an SSE error). Marker validation failures include the count, including zero or multiple markers. Logs omit prompts, history, tool arguments, credentials, and raw error text.

SDK `sdk_status`, `sdk_compact_boundary`, and `sdk_result` execution observations distinguish compaction attempts, completed boundaries, terminal reasons, API status, and advertised context/output limits. Failure text is represented only by a hash, character count, and fixed diagnostic keywords; keyword matches are clues, not error classifications. Request records also include message counts, prompt/tool/history character counts, requested output/thinking budgets, and `resizedImages`. History character counts describe the prepared request, include encoded image data, and are not token estimates.

`DOPPELCLAUDE_LOG_FILE=<path>` also appends every structured record (`startup`, `request_complete`, `runtime_close`) to that JSONL file, so telemetry outlives the container and whatever retention its log driver applies. Plain-text startup and failure lines stay on stderr only. Before a record would push the file past 64 MiB it rotates to `<path>.1` through `<path>.8`, about 576 MiB at most; records run around 1.5 KB, so that holds months of traffic. The parent directory must exist.

`DOPPELCLAUDE_RECORD_REQUESTS=<path>` is a diagnostic that writes prompts and history to disk. It is off by default. When set, every request admitted to a runtime appends one JSON line to that file with `timestamp`, `requestId`, `threadId`, `requestKind`, `requestedModel`, `resolvedModel`, the prepared `systemPrompt`, the prepared `tools`, and the inbound `request` body with its system prompt, tools, and messages. `requestId` matches the request's `request_complete` record, which stays hash-only. The file grows without bound and holds whatever the client sent, so enable it only for a capture, keep it on the state volume, and remove it afterward.

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
