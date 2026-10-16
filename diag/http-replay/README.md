# HTTP replay

Checks a change to the HTTP frontend's runtime routing against recorded production traffic, then on real Claude Code.

## Offline replay

`replay.ts` feeds a `DOPPELCLAUDE_RECORD_REQUESTS` capture through a given `server.ts` with a fake runtime and compares each request's decision with the production `request_complete` log, joined by `requestId`.

- Requests start and finish in production's order (start = log timestamp − `durationMs`), so overlaps within a thread are reproduced exactly; the fake runtime holds each turn until its production end.
- The server runs on a simulated clock, and the harness runs its idle-expiry sweep at every event, so expiry also matches production.
- A request's reply is the assistant message the next request on that thread echoes back; a reply nobody echoed is a placeholder. Because the fake replies with Amp's echo, the replay cannot see differences between what Claude Code returned and what the client sends back; it tests routing, not representation.
- A 409 is never recorded. It is replayed as a copy of the request then running on that thread, which is what Amp resends after a dropped stream.

Capture and run, with the log covering the same window:

```sh
sudo cat /mnt/black-box/docker/doppelclaude/diagnostics/requests.jsonl > .amp/in/corpus/requests.jsonl
docker logs --since <capture start> doppelclaude-doppelclaude-1 2>&1 | grep '^{' > .amp/in/corpus/log.jsonl
git show <deployed revision>:packages/http-doppelclaude/src/server.ts > .amp/in/replay/server-old.ts
node --max-old-space-size=8192 --import tsx diag/http-replay/replay.ts \
  --server "$PWD/.amp/in/replay/server-old.ts" \
  --requests .amp/in/corpus/requests.jsonl --log .amp/in/corpus/log.jsonl --out .amp/in/replay/old.json
```

The capture holds full prompts and history: keep it under `.amp/in/`, never in the repository.

**Gate:** the deployed revision must reproduce every production decision (`matchingProduction` equals `requests`). Until it does, the harness is wrong and its verdict on a change means nothing. Then run the changed `server.ts` and read each row's `differences`, `lane` and `threadRuntimes` in the output.

## Live scenarios

`live-overlap.ts` runs main → Oracle → main, two parallel Oracle calls, and a retry sent while the original still runs, against a given `server.ts` on real Claude Code, printing status, rebuild reason, lane, query reuse and cache usage per request. It spends a little Haiku quota. It needs Claude Code credentials in the environment, for example the daemon's token through ansiblonomicon's `scripts/fnox-host exec --secret CLAUDE_CODE_OAUTH_TOKEN`, with `CLAUDE_CONFIG_DIR` pointed at a scratch directory.
