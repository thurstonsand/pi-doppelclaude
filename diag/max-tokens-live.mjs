#!/usr/bin/env node

// Live probe: can `query.applyFlagSettings({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS } })`
// change the outgoing `max_tokens` of a running Claude Code query without a respawn?
//
// A slim proxy sits on ANTHROPIC_BASE_URL and records only request metadata
// (max_tokens, model, message count) and the SSE stop_reason/usage. Bodies are
// never written to disk.
//
//   node diag/max-tokens-live.mjs [--model claude-haiku-4-5]
//
// Costs subscription quota: four short turns, one deliberately truncated.

import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { query } from "@anthropic-ai/claude-agent-sdk";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const MODEL = flag("model", "claude-haiku-4-5");
const UPSTREAM = "api.anthropic.com";

const wire = [];

const proxy = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const record = { path: req.url, at: new Date().toISOString() };
    if (req.url.startsWith("/v1/messages")) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        record.max_tokens = parsed.max_tokens;
        record.model = parsed.model;
        record.messages = parsed.messages?.length;
      } catch {
        record.parseError = true;
      }
      wire.push(record);
    }
    const upstream = httpsRequest(
      {
        host: UPSTREAM,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: UPSTREAM },
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        let sse = "";
        up.on("data", (c) => {
          if (record.max_tokens !== undefined) sse += c.toString("utf8");
          res.write(c);
        });
        up.on("end", () => {
          if (record.max_tokens !== undefined) {
            record.status = up.statusCode;
            const delta = [...sse.matchAll(/^data: (\{"type":"message_delta".*)$/gm)].at(-1);
            if (delta) {
              const d = JSON.parse(delta[1]);
              record.stop_reason = d.delta?.stop_reason;
              record.output_tokens = d.usage?.output_tokens;
            }
            const start = sse.match(/^data: (\{"type":"message_start".*)$/m);
            if (start) {
              const u = JSON.parse(start[1]).message?.usage ?? {};
              record.cache_read = u.cache_read_input_tokens;
              record.cache_creation = u.cache_creation_input_tokens;
            }
          }
          res.end();
        });
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    upstream.end(body);
  });
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const port = proxy.address().port;

function inputQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(m) {
      const w = waiters.shift();
      if (w) w({ value: m, done: false });
      else items.push(m);
    },
    close() {
      closed = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          items.length
            ? Promise.resolve({ value: items.shift(), done: false })
            : closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => waiters.push(resolve)),
      };
    },
  };
}

const input = inputQueue();
const q = query({
  prompt: input,
  options: {
    model: MODEL,
    cwd: process.cwd(),
    tools: [],
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt: "You are a terse test subject. Follow instructions exactly.",
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000",
    },
  },
});

const turns = [
  { ceiling: null, text: "Reply with exactly: one" },
  { ceiling: "16384", text: "Reply with exactly: two" },
  { ceiling: "64", text: "Write a 300-word story about a lighthouse keeper. Do not stop early." },
  { ceiling: "32000", text: "Reply with exactly: four" },
];

const iterator = q[Symbol.asyncIterator]();
async function untilResult(label) {
  const seen = { assistantText: 0, stopReasons: [], resultSubtype: null, apiError: null };
  for (;;) {
    const { value: m, done } = await iterator.next();
    if (done) throw new Error(`${label}: stream ended before result`);
    if (m.type === "stream_event" && m.event.type === "message_delta") {
      seen.stopReasons.push(m.event.delta?.stop_reason ?? null);
    }
    if (m.type === "assistant") {
      seen.assistantText += (m.message.content ?? [])
        .filter((b) => b.type === "text")
        .reduce((n, b) => n + b.text.length, 0);
      if (m.apiError) seen.apiError = m.apiError;
    }
    if (m.type === "result") {
      seen.resultSubtype = m.subtype;
      seen.usage = m.usage && {
        output: m.usage.output_tokens,
        cache_read: m.usage.cache_read_input_tokens,
        cache_creation: m.usage.cache_creation_input_tokens,
      };
      return seen;
    }
  }
}

const summary = [];
for (const [i, turn] of turns.entries()) {
  const before = wire.length;
  if (turn.ceiling !== null) {
    const t0 = Date.now();
    await q.applyFlagSettings({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: turn.ceiling } });
    console.error(
      `turn ${i + 1}: applyFlagSettings(${turn.ceiling}) acknowledged in ${Date.now() - t0}ms`,
    );
  }
  input.push({
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: turn.text },
  });
  const seen = await untilResult(`turn ${i + 1}`);
  const requests = wire.slice(before).map(({ path, at, ...rest }) => rest);
  summary.push({
    turn: i + 1,
    requestedCeiling: turn.ceiling ?? "32000 (spawn env)",
    requests,
    sdk: seen,
  });
}
input.close();
await q.return?.();
proxy.close();

console.log(JSON.stringify(summary, null, 2));

const verdicts = [];
for (const s of summary) {
  const expected = Number(s.requestedCeiling.split(" ")[0]);
  const wireValues = s.requests.map((r) => r.max_tokens);
  verdicts.push({
    turn: s.turn,
    expected,
    wire: wireValues,
    honored: wireValues.length > 0 && wireValues.every((v) => v === expected),
  });
}
console.log("\nverdict:");
for (const v of verdicts)
  console.log(
    `  turn ${v.turn}: expected ${v.expected} wire ${JSON.stringify(v.wire)} ${v.honored ? "OK" : "MISMATCH"}`,
  );
process.exit(verdicts.every((v) => v.honored) ? 0 : 1);
