# Amp custom-connection wire behavior

What Amp actually sends to an "Anthropic Messages API compatible" Custom URL connection, captured
2026-09-15 with `diag/amp-recorder/` behind a Cloudflare quick tunnel, driven from `amp -x` through a
project plugin mode whose agent model was `doppelclaude/claude-opus-5`. Raw captures are not kept:
they contain the user's global AGENTS.md and account id. Only settled facts are recorded.

## Settled

1. **Amp's servers call the Base URL, not the client.** Every inference request arrived from
   Google Cloud addresses (`34.10.59.143`, `34.122.195.118`). `localhost` cannot work; the endpoint
   must be publicly reachable.
2. **No dedicated conversation header or `metadata` field was observed.** The original conclusion that there was no identifier anywhere was too broad: the 2026-09-18 follow-up below found the actual thread URL inside a system text block. Request headers in the initial capture were the stock Anthropic JS SDK set (`Anthropic/JS 0.78.0`, `X-Stainless-*`, `Anthropic-Version: 2023-06-01`). The API key arrived twice: `Authorization: Bearer <key>` and `x-api-key: <key>`.
3. **Amp rewrites `tool_use` ids.** A `toolu_recorder_…` id emitted in the response came back in the
   next request as `TU-034P3aBRor2OI3fhddq2IC`, on both the `tool_use` block and its `tool_result`.
   History comparison cannot key on tool ids.
4. **Thinking blocks are echoed verbatim with their signatures**, including a fabricated one. Amp is a
   faithful echo.
5. **History is byte-stable across turns**, ignoring `cache_control`, which Amp moves to the last
   block of the last message on each request. System blocks and the tool list were identical across
   every request in a thread.
6. **Model id is provider-qualified**: `doppelclaude/claude-opus-5`. The provider segment is the
   connection's name in Amp.
7. **Body parameters** on a high-effort agent: `max_tokens: 128000`,
   `thinking: {type: "adaptive", display: "summarized"}`, `output_config: {effort: "high"}`,
   `stream: true`. No `temperature`, `top_p`, `stop_sequences`, or `tool_choice`.
8. **System prompt** is an array of three text blocks, each with
   `cache_control: {type: "ephemeral", ttl: "1h"}`: Amp's agent preamble, the mode's instructions,
   and the user's global AGENTS.md. About 9k characters for a bare spike mode.
9. **Tools**: 43 with `tools: 'all'`, plain `{name, description, input_schema}` only. No
   `defer_loading`, `cache_control`, or `type` fields. Six descriptions exceed Claude Code's 2048
   character MCP description cap (`skill` 11,664; `painter` 7,663; `find_thread` 5,209; `oracle`
   and `Task` 4,274; `read_thread` 2,765). Amp's own deferred-tool mechanism is client-side: a
   `tool_search` tool that returns importable modules for `code_exec`.
10. **Tool results** arrive as `{type: "tool_result", tool_use_id, is_error: false, content: [{type:
    "text", text}]}` with `cache_control` on the block.
11. **Every user turn is a text-block array**: a timezone note, an `<amp_message_author …/>` tag, then
    the user's text. The timezone block appears only on the first message.
12. **`/v1/models` was not called in the initial capture.** "Configure" in the connection dialog opened the Base URL in a browser (favicon fetches from the user's IP) and found nothing. The 2026-09-18 follow-up did receive one authenticated `GET /v1/models` before the first inference request, so "never called" is not a valid endpoint assumption.
13. **Compaction is client-side and goes through the connection.** With a low
    `compactionThresholdTokens` and inflated `usage.input_tokens`, Amp sent the full history plus a
    final user message beginning `[This message is inserted by Amp, not written by the user.]` with a
    ~1,000 word handoff-summary instruction, same system prompt and tools. It retried the request
    three times (all `X-Stainless-Retry-Count: 0`) when the reply was not a summary, then wedged the
    thread with `Compaction failed`.
14. **Subagents do not use the connection.** A `Task` call from a custom-connection mode ran on Amp's
    own default model; only the parent's `tool_result` reached the endpoint.
15. **Amp does not retry a 529.** `overloaded_error` was surfaced to the user verbatim on the first
    attempt. The endpoint owns retries.
16. **Thread titles are generated elsewhere.** No auxiliary request reached the endpoint for titles.

## Session identity follow-up — 2026-09-18 UTC

**Amp supplied the actual current thread ID in every one of 12 inference requests.** It appeared in `system[2].text`, in a line with this prefix:

```text
Amp Thread URL: https://ampcode.com/threads/<current-thread-id>
```

This was a real Amp-to-recorder experiment, not a replay. Amp CLI `0.0.1789688804-g2e89b8` ran with `--executor local` inside the orb. A temporary project mode pinned `amp-session-spike/claude-opus-5`, high reasoning effort, and only `shell_command`. A separate personal Anthropic Messages custom route reached the authenticated recorder through a Cloudflare quick tunnel. No Claude Code inference was involved; the recorder supplied synthetic thinking, a harmless `echo` tool call, and a final text response.

Two threads used identical prompts, mode instructions, working directory, title, and connection. Three user turns per thread were interleaved A1, B1, A2, B2, A3, B3. Every user turn caused two HTTP requests: the initial request and the tool-result continuation. Each follow-up launched a fresh CLI process using `amp threads continue`. The recorder was restarted before A3; its fingerprint key persisted.

| Ground-truth thread | User turns | Inference requests | Requests containing its actual ID | Message counts |
| --- | ---: | ---: | ---: | --- |
| [A](https://ampcode.com/threads/T-01a0b1e4-bcfb-7776-9cc0-707b6dbc9d4c) | 3 | 6 | 6 | 1, 3, 5, 7, 9, 11 |
| [B](https://ampcode.com/threads/T-01a0b1e5-0bfa-7179-b8b9-2848d2f64025) | 3 | 6 | 6 | 1, 3, 5, 7, 9, 11 |

Ground truth came from each CLI run's `system/init.session_id` and the controlled request order, not from choosing an ID in the request. The recorder HMACed every scalar request field and every embedded thread ID. Assertions matched each actual CLI thread ID against all six requests in its group. After detecting the IDs, an exact-prefix detector confirmed the `Amp Thread URL:` label in the final four requests; the whole system text fingerprint was unchanged across all six requests within each thread.

The only field stable within each thread and different between threads was `/json/system/2/text`. No header qualified. `Cf-Connecting-Ip`, `Cf-Ray`, `Content-Length`, and `X-Forwarded-For` varied within threads; the other header values were shared. The body keys were `model`, `max_tokens`, `messages`, `system`, `tools`, `stream`, `thinking`, and `output_config`: no `metadata`. None of the recorder's emitted message IDs appeared as a scalar value in subsequent requests.

There was also an unrelated parent-thread ID in the same system block, shared by both threads. It did not carry the `Amp Thread URL:` label. Picking the first UUID or first thread reference would have selected the wrong conversation. This probe did not insert either test thread's ID into its prompts, instructions, or configured headers.

**Design consequence:** the Amp frontend can potentially extract the explicitly labelled thread URL as an affinity hint, rather than relying on global longest-prefix matching for every request. Still validate history before reuse. Treat missing or ambiguous labels conservatively, and do not use prompt text as authentication. This is observed prompt formatting, not a documented transport guarantee. Forks, compaction, browser/orb-native execution, and other modes need their own checks before making the hint mandatory. The capture does not establish whether the earlier client omitted the line or the initial analysis overlooked it.

The temporary route was deleted, both services were stopped, and the two test threads were archived. The existing Doppelclaude route was not changed. The recorder retained fingerprints only; no raw prompts or credential values were captured.

## Not yet observed

- Mid-stream cancel from the Amp app (the CLI has no cancel).
- Image attachments.
- Non-streaming requests (none seen; `stream: true` on every request).
