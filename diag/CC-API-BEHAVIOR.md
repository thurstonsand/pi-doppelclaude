# Claude Code's API behavior, as captured on the wire

Imported from upstream `pi-claude-bridge`, commit `58713e1` and its `diag/AUDIT.md`.
Upstream's log/transcript scanners were not imported, so their corpus baselines are
not reproducible here; only the facts the request captures settled are kept, plus
the one question that stayed open.

## Method

`diag/capture-proxy.mjs` sits between Claude Code and `api.anthropic.com`. The
bridge passes `process.env` to the CC child and the SDK honours
`ANTHROPIC_BASE_URL`, so pointing that at the proxy records the exact request
bodies CC sends, paired with the `cache_read`/`cache_creation` numbers off the
response stream.

```
node diag/capture-proxy.mjs --out /tmp/cap &
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 pi --model doppelclaude/claude-haiku-4-5
node diag/diff-captures.mjs /tmp/cap
```

Subscription OAuth forwards through a custom base URL, so no `ANTHROPIC_API_KEY`
is needed — settled. The capture dir holds whole conversations; treat it as
sensitive. Authorization headers are forwarded upstream but never written to disk.

`diff-captures.mjs` pairs each captured `/v1/messages` request with the previous
one and reports the first prompt element that differs — a system block, the tool
list, or a specific message — alongside whether the cache read covered what the
previous request left cached (`cacheRead + cacheWrite`, not including its uncached
`input`). A cold boundary with a byte-identical prefix means the cause is not in
our bytes. Toolless side requests (titles, summaries) are filtered out, a
shrinking message count is treated as a new session rather than a boundary, and
the billing header block is excluded from the comparison — it changes every
request without breaking the cache (finding 1), so comparing it would report a
divergence at position 0 on every boundary and hide the real one.

## Settled

1. **CC's per-request billing header does not break the prompt cache.** `system[0]`
   is `x-anthropic-billing-header: … cch=<hash>`, carries no `cache_control`, and
   changes on every request — yet a later request read back exactly the 12,205
   tokens an earlier one had written under a different `cch=`. The cached prefix
   begins after it.
2. **CC asks for a 1-hour cache TTL.** Both cacheable system blocks carry
   `cache_control: {type: "ephemeral", ttl: "1h"}` on `/v1/messages?beta=true` — not
   the default five minutes.
3. **CC's resume does not preserve the order of same-millisecond parallel
   `tool_result` blocks.** Ten sessions, each one turn of 10 parallel `Read` calls
   followed by a resume: 8 of 10 came back reordered against the on-disk order,
   always as adjacent-pair swaps, and every swapped pair shared a millisecond
   timestamp. The live request matched disk 10 of 10, so the write is faithful and
   the read is not. Deterministic per session file (three resumes, identical order
   each time), so the cost is one cache write, not a recurring tax. Rare in
   practice: real batches are 2–3 calls whose results land milliseconds apart, and
   bridge-written records cannot tie at all because a turn's results go into one
   record with one timestamp — only CC's live-appended groups are exposed. A
   genuine, filable Claude Code fidelity bug, reproducible on demand at ~80% with
   ten parallel reads.

## Open: the cold-resume tax

Upstream's log corpus showed ~25% of `--resume` boundaries re-sending the whole
conversation (28.5% even within 5 minutes of the previous request, against a 0.6%
in-query control), costing 12.9M re-cached tokens over an April–July window. The
captures did **not** reproduce it: 33 bridge-free controlled boundaries at 45–85k
prompts on Haiku came back 0 cold. The audited failures were `claude-opus-5[1m]`
at high effort with 100–400k prompts, a regime the controlled runs never reached,
so the tooling has never yet been pointed at a request that actually broke.

Two caveats on the corpus finding:

- The break metric originally expected `input + cacheRead + cacheWrite` from the
  previous request, which counts its uncached input as if it must return cached.
  A tool-heavy turn sends its whole result payload that way, so the old formula
  invented shortfalls on precisely the tool-heavy turns. Corrected to
  `cacheRead + cacheWrite` (what `diff-captures.mjs` uses) the corpus rate barely
  moved, but upstream's dose-response table — "cold rate rises with the number of
  tool calls in the previous query" — was built on the false-positive mode and
  should not be relied on without recomputation.
- Finding 2 reinterprets upstream's idle-gap table: under a 1h TTL the >1h row
  (96.7% cold) is plain expiry, but 15–60min at 78.3% is not, so either the TTL
  request is newer than that log window or something else evicts well inside it.

If the tax is real it is Claude Code's, not the bridge's: the worst cases were
`reuse` boundaries where the bridge never touched the session file, and the
records implicated are the ones CC itself appended during the previous query. That
would make every SDK consumer that resumes a session pay it.

## Also worth knowing

Claude Code has its own cache-break detector
(`services/api/promptCacheBreakDetection.ts`, same 2,000-token threshold used
above) whose reason strings — "system prompt changed (+N chars)", "tools changed",
"possible 5min TTL expiry (prompt unchanged)", "likely server-side" — are emitted
under debug mode, which the bridge already enables for every query. Upstream found
no `PROMPT CACHE BREAK` string in the SDK version it ran; if a future SDK bump
ships it, grepping `~/.pi/agent/cc-cli-logs/*.log` for that prefix is cheaper than
running this proxy.
