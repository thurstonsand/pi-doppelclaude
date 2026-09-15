# amp-recorder

A dependency-free Node.js (v20+) HTTP server that records everything a coding-agent client sends to an Anthropic Messages API compatible endpoint, while returning valid responses so the client keeps working.

## Run

```sh
node /tmp/amp-recorder/server.mjs
# or on another port
PORT=9000 node /tmp/amp-recorder/server.mjs
```

It listens on all interfaces and appends one NDJSON line per request to `/tmp/amp-recorder/requests.ndjson`.

Point the client at it with `ANTHROPIC_BASE_URL=http://localhost:8080` (Amp: whatever its Anthropic base URL setting is).

## Expose it remotely

If the client calls from somewhere other than this machine, front it with a Cloudflare quick tunnel:

```sh
cloudflared tunnel --url http://localhost:8080
```

Use the printed `https://<random>.trycloudflare.com` URL as the client's base URL.

## Inspect the recording

Distinct header names seen across all recorded requests:

```sh
jq -r '.headers | keys[]' /tmp/amp-recorder/requests.ndjson | sort -u
```

Every `messages` array that was sent:

```sh
jq -c 'select(.json.messages != null) | {timestamp, model: .json.model, messages: .json.messages}' /tmp/amp-recorder/requests.ndjson
```

## Behavior

- `GET /v1/models`, `GET /models` — Anthropic Models API list shape.
- `POST /v1/messages`, `POST /messages` — SSE stream when `stream: true`, otherwise the equivalent JSON message. The assistant reply is always `recorder: ok`.
- `POST /v1/messages/count_tokens` — `{"input_tokens": 10}`.
- Anything else — `200 {"ok":true,"recorded":true}`, so unexpected calls get recorded without breaking the client.
- `OPTIONS` — `204` with permissive CORS headers (all origins, methods, headers).
- Bodies up to 50 MB. A client that disconnects mid-stream logs `client disconnected` to stdout and a `client_disconnected` marker line to the NDJSON.
