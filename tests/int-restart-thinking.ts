#!/usr/bin/env node
// Verifies that Claude's thinking survives a pi restart.
//
// Claude binds each thinking block to everything before it, including the context Claude Code put
// into the first message. A new pi process has no Claude Code transcript, so its rebuild renders
// that context from what the bridge saved in the session. Without it, the API drops every earlier
// thinking block (`prefix_binding_mismatch`) and the cache misses from message 0 on. The HTTP
// daemon keeps the same context in its state directory, so the same holds across its restarts.

console.log("=== int-restart-thinking.ts ===");

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer } from "http-doppelclaude";
import { createRpcHarness } from "./lib/rpc-harness.js";

const TIMEOUT = 180_000;
const MODEL = "doppelclaude/claude-haiku-5-5";
const CONTEXT_CUSTOM_TYPE = "pi-doppelclaude.context";

interface Entry {
  type: string;
  customType?: string;
  data?: { attachments?: unknown[] };
  message?: {
    role: string;
    content: Array<{ type: string; thinkingSignature?: string }>;
    usage?: { cacheRead: number; cacheWrite: number };
    diagnostics?: Array<{ type: string; details?: unknown }>;
  };
}

const CWD = mkdtempSync(join(tmpdir(), "pi-doppelclaude-restart-"));
const SESSIONS = join(CWD, "sessions");

function harness(name: string, extra: string[]) {
  return createRpcHarness({
    name,
    args: ["--model", MODEL, "--thinking", "high", "--session-dir", SESSIONS, ...extra],
    cwd: CWD,
    defaultTimeout: TIMEOUT,
    persistSession: true,
  });
}

function assistants(entries: Entry[]) {
  return entries.flatMap((entry) =>
    entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : [],
  );
}

interface HttpTurn {
  blocks: Array<Record<string, unknown>>;
  transformations: unknown;
  usage: { cache_read: number | null; cache_creation: number | null };
}

/** One request to a daemon that starts for it and stops after it, as a restart between turns. */
async function httpTurn(stateDir: string, messages: unknown[]): Promise<HttpTurn> {
  const logs: Array<Record<string, unknown>> = [];
  const server = createHttpServer({
    apiKey: "int",
    supportedModels: [],
    stateDir,
    log: (record) => logs.push(record),
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "int" },
      body: JSON.stringify({
        model: "claude-haiku-5-5",
        max_tokens: 8000,
        stream: true,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        system: `You are a careful assistant.\n${FILLER}\nAmp Thread URL: https://ampcode.com/threads/${THREAD}`,
        messages,
      }),
    });
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const blocks: Array<Record<string, unknown>> = [];
    let transformations: unknown;
    for (const line of (await response.text()).split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "message_start") transformations = event.message.input_transformations;
      else if (event.type === "content_block_start") blocks[event.index] = event.content_block;
      else if (event.type === "content_block_delta") {
        const block = blocks[event.index];
        const delta = event.delta;
        if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
        else if (delta.type === "thinking_delta")
          block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
        else if (delta.type === "signature_delta") block.signature = delta.signature;
      }
    }
    for (let i = 0; i < 500 && !logs.some((r) => r.event === "request_complete"); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const record = logs.find((r) => r.event === "request_complete");
    if (!record) throw new Error("no request_complete record");
    return { blocks, transformations, usage: record.usage as HttpTurn["usage"] };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// Large enough to cross the prompt-cache minimum, so cache reads mean something.
const FILLER = Array.from({ length: 500 }, (_, i) => `Reference note ${i}: be precise.`).join("\n");
const THREAD = `T-0000000f-${String(Date.now()).slice(-4)}-4000-8000-00000000000f`;

let failedLogs: string[] = [];
try {
  const first = harness("restart-thinking-1", []);
  failedLogs = [first.DEBUG_LOG];
  await first.startAndWait();
  const answer1 = await first.promptAndWait(
    "Think carefully: what is the sum of the digits of 2^20? Reply with only the number.",
  );
  await first.stop();
  console.log(`  turn 1: ${answer1.trim()}`);

  const [file] = readdirSync(SESSIONS).filter((name) => name.endsWith(".jsonl"));
  if (!file) throw new Error("pi saved no session");
  const sessionPath = join(SESSIONS, file);
  const read = () =>
    readFileSync(sessionPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Entry);

  const [turn1] = assistants(read());
  if (!turn1?.content.some((block) => block.type === "thinking" && block.thinkingSignature))
    throw new Error("turn 1 has no signed thinking to keep");
  const saved = read().filter((entry) => entry.customType === CONTEXT_CUSTOM_TYPE);
  if (!saved.at(-1)?.data?.attachments?.length)
    throw new Error("the session holds no saved Claude Code context");
  console.log(`  saved context: ${saved.at(-1)?.data?.attachments?.length} attachments`);

  const second = harness("restart-thinking-2", ["--session", sessionPath]);
  failedLogs = [first.DEBUG_LOG, second.DEBUG_LOG];
  await second.startAndWait();
  const answer2 = await second.promptAndWait("Now double it. Reply with only the number.");
  await second.stop();
  console.log(`  turn 2 (after restart): ${answer2.trim()}`);

  const debugLog = readFileSync(second.DEBUG_LOG, "utf8");
  if (!/syncResult: path=rebuild .* context=saved/.test(debugLog))
    throw new Error("the restarted rebuild did not use the saved context");

  const [, turn2] = assistants(read());
  if (!turn2) throw new Error("turn 2 was not saved");
  const dropped = turn2.diagnostics?.find((d) => d.type === "anthropic_input_transformations");
  if (dropped) throw new Error(`the API dropped thinking: ${JSON.stringify(dropped.details)}`);
  const cached = (turn1.usage?.cacheRead ?? 0) + (turn1.usage?.cacheWrite ?? 0);
  const read2 = turn2.usage?.cacheRead ?? 0;
  console.log(`  turn 1 cached ${cached}, turn 2 read ${read2}`);
  if (read2 < cached)
    throw new Error(
      `turn 2 read ${read2} cached tokens, less than the ${cached} turn 1 cached: message 0 changed`,
    );
  console.log("PASS: thinking and the message-0 cache survive a pi restart");

  const stateDir = join(CWD, "http-state");
  const ask = {
    role: "user",
    content: "Think carefully: what is the sum of the digits of 3^15? Reply with only the number.",
  };
  const http1 = await httpTurn(stateDir, [ask]);
  if (!http1.blocks.some((block) => block.type === "thinking" && block.signature))
    throw new Error("HTTP turn 1 has no signed thinking to keep");
  const http2 = await httpTurn(stateDir, [
    ask,
    { role: "assistant", content: http1.blocks },
    { role: "user", content: "Now double it. Reply with only the number." },
  ]);
  console.log(`  HTTP turn 2 input_transformations: ${JSON.stringify(http2.transformations)}`);
  if (!Array.isArray(http2.transformations) || http2.transformations.length)
    throw new Error("the API dropped thinking after a daemon restart");
  const httpCached = (http1.usage.cache_read ?? 0) + (http1.usage.cache_creation ?? 0);
  const httpRead = http2.usage.cache_read ?? 0;
  console.log(`  HTTP turn 1 cached ${httpCached}, turn 2 read ${httpRead}`);
  if (httpCached === 0) throw new Error("HTTP turn 1 cached nothing, so the cache check is empty");
  if (httpRead < httpCached)
    throw new Error(`HTTP turn 2 read ${httpRead} cached tokens, less than ${httpCached}`);
  console.log("PASS: thinking and the message-0 cache survive an HTTP daemon restart");
} catch (error) {
  process.exitCode = 1;
  console.log(`FAIL: ${(error as Error).message}`);
  for (const log of failedLogs) console.log(`  Debug log: ${log}`);
} finally {
  rmSync(CWD, { recursive: true, force: true });
}
