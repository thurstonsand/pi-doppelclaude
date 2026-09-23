# SMOKE.md

Live checks against the real Claude Code binary. Every run consumes subscription quota; run them when a change touches the SDK, pi, or either frontend, not routinely. They need Claude auth (`claude auth login` or `CLAUDE_CODE_OAUTH_TOKEN`).

## After a pi or Agent SDK bump

1. `mise run check` — the prompt-structure canaries in `tests/unit-system-prompt.ts` fail if pi renamed a section or a docs label.
2. Re-record the SDK stream fixtures (see DEV.md) and read the diff.
3. Run the pi smoke and the HTTP smoke below.

## Pi

Point pi at a scratch agent dir whose `settings.json` carries your real `doppelclaude` block (replacements included) with `debug.enabled: true`, so the run exercises your prompt rather than an empty one.

```sh
mise run build
export PI_CODING_AGENT_DIR=$PWD/.test-output/agent-smoke
pi -ne -e ./packages/pi-doppelclaude/dist/index.js -p --model doppelclaude/claude-haiku-4-5 \
  'Read CHANGELOG.md and reply with its first heading, verbatim.'
```

Pass: the reply quotes the file. In `$PI_CODING_AGENT_DIR/doppelclaude.log`:

- `tools=N` with N above zero — zero means Claude Code was handed no tools.
- a `syncResult` line with the expected path (`clean-start` on a fresh session).
- an `mcp handler: read` line — the tool call round-tripped through pi.
- no 400. A 400 billed as extra usage means pi's wording reached Anthropic; check the replacements still land.

## HTTP

Start the daemon with a key file and note its base URL. In an orb, `amp orb services ensure` builds and starts it from `.amp/services.yaml` and prints a portal URL; the portal accepts the daemon key alone, so no Amp sign-in is involved.

```sh
KEY=$(cat .test-output/http-state/api-key)
curl -sS -H "x-api-key: $KEY" "$BASE/v1/models"
curl -sS -N -X POST "$BASE/v1/messages" -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":64,"stream":true,"system":[{"type":"text","text":"Amp Thread URL: https://ampcode.com/threads/T-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"}],"messages":[{"role":"user","content":"Reply with exactly: http-ok"}]}'
```

Pass:

- `/v1/models` lists the served models; without the key, 401.
- an unknown top-level property returns 400 naming that property.
- the stream runs `message_start` through `message_stop` and says `http-ok`.
- a second turn that replays the first assistant message exactly, thinking block included, logs `sync: compatible` and `query_reused`. A hand-written history that drops the thinking block rebuilds; that is correct.

The marker must match `THREAD_LINE` in `server.ts`, or the request is a 400 at the edge. `amp orb service logs doppelclaude-http | rg '"requestKind"'` (or the daemon's stdout elsewhere) shows the per-request diagnostic.
