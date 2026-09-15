# Amp custom-connection wire behavior

What Amp actually sends to an "Anthropic Messages API compatible" Custom URL connection, captured
2026-09-15 with `diag/amp-recorder/` behind a Cloudflare quick tunnel, driven from `amp -x` through a
project plugin mode whose agent model was `doppelclaude/claude-opus-5`. Raw captures are not kept:
they contain the user's global AGENTS.md and account id. Only settled facts are recorded.

## Settled

1. **Amp's servers call the Base URL, not the client.** Every inference request arrived from
   Google Cloud addresses (`34.10.59.143`, `34.122.195.118`). `localhost` cannot work; the endpoint
   must be publicly reachable.
2. **No conversation identifier of any kind.** Request headers are the stock Anthropic JS SDK set
   (`Anthropic/JS 0.78.0`, `X-Stainless-*`, `Anthropic-Version: 2023-06-01`). No thread id, no
   `metadata` in the body. The API key arrives twice: `Authorization: Bearer <key>` and
   `x-api-key: <key>`.
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
12. **`/v1/models` is never called.** "Configure" in the connection dialog opened the Base URL in a
    browser (favicon fetches from the user's IP) and found nothing; models are typed in by hand.
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

## Not yet observed

- Mid-stream cancel from the Amp app (the CLI has no cancel).
- Image attachments.
- Non-streaming requests (none seen; `stream: true` on every request).
