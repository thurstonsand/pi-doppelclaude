# amp-recorder

A dependency-free Node.js (v20+) HTTP server that fingerprints requests to an Anthropic Messages API compatible endpoint, while returning synthetic responses so the client keeps working. This tests Amp's wire behavior, not the Claude Code bridge.

## Run

```sh
umask 077
openssl rand -hex 32 > /tmp/amp-recorder-key
RECORDER_KEY_FILE=/tmp/amp-recorder-key node diag/amp-recorder/server.mjs
```

It listens on all interfaces on `PORT` (default 8080) and appends NDJSON to `RECORDER_DIR/requests.ndjson` (default directory `/tmp/amp-recorder`). Send the key using `Authorization: Bearer` or `x-api-key`; unauthenticated requests receive 401 and are not recorded. Do not commit the key or capture files.

Amp needs an HTTPS Custom URL connection with the Anthropic Messages format. Use a dedicated test model mapping; do not redirect ordinary models into this synthetic endpoint.

## Expose it remotely

If the client calls from somewhere other than this machine, front it with a Cloudflare quick tunnel. In an Amp orb, supervise both processes with `amp orb service start`, rather than backgrounding them in a shell:

```sh
cloudflared tunnel --url http://localhost:8080
```

Use the printed `https://<random>.trycloudflare.com` URL as the client's base URL.

## Inspect the recording

Captures contain field paths and HMAC fingerprints, not raw header values or message text. A random key in `RECORDER_DIR/fingerprint-key` makes fingerprints comparable across requests and restarts using that directory. Keep the key private; use it with `fingerprint(knownThreadId, key)` to check whether an embedded ID names the actual test thread. `threadIds` reports paths containing Amp thread IDs, with those IDs fingerprinted too; `ampThreadUrl` marks matches immediately following the exact line prefix `Amp Thread URL: https://ampcode.com/threads/`. This detects prompt formatting, not a trusted identity claim. Response markers fingerprint emitted message IDs so their presence in subsequent requests can be checked.

Distinct header paths seen across all recorded requests:

```sh
jq -r '.fields // {} | keys[] | select(startswith("/headers/"))' /tmp/amp-recorder/requests.ndjson | sort -u
```

Run the offline comparison tests:

```sh
node --test diag/amp-recorder/identity.test.mjs
```

For session identity, create two separate threads using identical first prompts and the same mode, directory, and connection. Interleave at least two user turns per thread and include a tool continuation. Associate captures with known threads out of band, not with a distinguishing prompt or header that would manufacture the identifier being sought. Pass each thread's request records as one group to `compareSessions` in `identity.mjs`.

The comparison separates fields stable within each thread but distinct between threads (`candidates`) from shared, varying, and missing fields. Inspect embedded `threadIds` separately, including whether they name the current thread or merely reference another thread. A candidate is evidence to investigate, not proof of a routing contract. Fields first appearing in assistant history can help match continuations but cannot distinguish identical initial requests. Cancellation, forks, and compaction require separate probes.

## Behavior

- `GET /v1/models`, `GET /models` — Anthropic Models API list shape.
- `POST /v1/messages`, `POST /messages` — SSE stream when `stream: true`, otherwise the equivalent JSON message. The assistant reply is always `recorder: ok`.
- `POST /v1/messages/count_tokens` — `{"input_tokens": 10}`.
- Anything else — `200 {"ok":true,"recorded":true}`, so unexpected calls get recorded without breaking the client.
- `OPTIONS` — `204` with permissive CORS headers (all origins, methods, headers).
- Bodies up to 50 MB. A client that disconnects mid-stream logs `client disconnected` to stdout and a `client_disconnected` marker line to the NDJSON.
