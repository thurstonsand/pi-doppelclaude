#!/usr/bin/env node
// Verifies that a rebuilt transcript still reads the prompt cache the live query wrote.
//
// A rebuild only stays warm while it renders the same prompt prefix Claude Code sent live, and
// that depends on Claude Code internals the bridge imitates: where it keeps its injected context
// records, how it renders an empty tool result, the turn it writes when a query starts on tool
// results, and that it mirrors an unfinished turn into the store. When an SDK bump changes any of
// them, this fails with the rebuild reading less than the request before it cached.

console.log("=== int-rebuild-cache.ts ===");

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpServer } from "http-doppelclaude";

const MODEL = "claude-haiku-4-5";

type CompleteRecord = Record<string, unknown> & {
  lane?: string;
  sync?: string;
  usage?: { cache_read: number | null; cache_creation: number | null };
  executions?: Array<{ event: string; rebuild?: Record<string, unknown> | null }> | null;
};
type Block = Record<string, unknown>;

const logs: CompleteRecord[] = [];
const server = createHttpServer({
  apiKey: "int",
  supportedModels: [],
  stateDir: await mkdtemp(join(tmpdir(), "int-rebuild-cache-")),
  log: (record) => logs.push(record as CompleteRecord),
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no address");
const { port } = address;

const thread = `T-0000000c-${String(Date.now()).slice(-4)}-4000-8000-00000000000c`;
// Large enough to cross the prompt-cache minimum, so cache reads mean something.
const filler = Array.from(
  { length: 500 },
  (_, i) => `Reference note ${i}: the bridge keeps state.`,
);
const lookup = {
  name: "lookup",
  description: "Look up the value stored under a key. Always use it when asked for a key's value.",
  input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
};

async function post(
  label: string,
  messages: unknown[],
  threadId = thread,
): Promise<{ blocks: Block[]; record: CompleteRecord }> {
  const before = logs.length;
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "int" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      stream: true,
      thinking: { type: "enabled", budget_tokens: 2048 },
      system: `You are the main agent.\n${filler.join("\n")}\nAmp Thread URL: https://ampcode.com/threads/${threadId}`,
      tools: [lookup],
      messages,
    }),
  });
  if (response.status !== 200) throw new Error(`${label}: HTTP ${response.status}`);
  const blocks: Block[] = [];
  const json: string[] = [];
  for (const line of (await response.text()).split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "content_block_start") {
      blocks[event.index] = structuredClone(event.content_block);
      json[event.index] = "";
    } else if (event.type === "content_block_delta") {
      const block = blocks[event.index];
      const delta = event.delta;
      if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
      else if (delta.type === "thinking_delta")
        block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
      else if (delta.type === "signature_delta") block.signature = delta.signature;
      else if (delta.type === "input_json_delta") json[event.index] += delta.partial_json;
    } else if (event.type === "content_block_stop") {
      const block = blocks[event.index];
      if (block.type === "tool_use" && json[event.index])
        block.input = JSON.parse(json[event.index]);
    }
  }
  for (let i = 0; i < 100 && !logs.slice(before).some((r) => r.event === "request_complete"); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const record = logs.slice(before).find((r) => r.event === "request_complete");
  if (!record) throw new Error(`${label}: no request_complete record`);
  console.log(
    `${label}: sync=${record.sync} lane=${record.lane} read=${record.usage?.cache_read} write=${record.usage?.cache_creation} rebuild=${JSON.stringify(rebuildOf(record))}`,
  );
  return { blocks, record };
}

function rebuildOf(record: CompleteRecord) {
  return record.executions?.find((e) => e.event === "query_created")?.rebuild ?? null;
}

/** A rebuild that renders the live prefix differs from the live transcript nowhere they overlap. */
function assertNoDivergence(label: string, record: CompleteRecord) {
  const divergence = rebuildOf(record)?.divergence as { at: unknown } | null | undefined;
  console.log(`${label} divergence: ${JSON.stringify(divergence)}`);
  if (!divergence) throw new Error(`${label}: the rebuild reported no divergence check`);
  if (divergence.at !== null)
    throw new Error(`${label}: rebuilt transcript diverges at ${JSON.stringify(divergence.at)}`);
}

function text(value: string) {
  return { role: "user", content: [{ type: "text", text: value }] };
}

try {
  const messages: unknown[] = [text("Look up key k0 and tell me its value.")];
  // Turn 1's result is empty, so the rebuild must render it the way Claude Code does live.
  const results = ["", "value-k1"];
  for (let turn = 0; turn < 4; turn++) {
    const { blocks } = await post(`warm ${turn + 1}`, messages);
    messages.push({ role: "assistant", content: blocks });
    const calls = blocks.filter((block) => block.type === "tool_use");
    messages.push(
      calls.length
        ? {
            role: "user",
            content: calls.map((call) => ({
              type: "tool_result",
              tool_use_id: call.id,
              content: [{ type: "text", text: results.shift() ?? "value-extra" }],
            })),
          }
        : text(`Look up key k${turn + 1} and tell me its value.`),
    );
  }
  const warm = await post("warm final", messages);
  if (warm.record.lane !== "continued") throw new Error("warm final did not continue its lane");

  // An assistant turn Claude Code never produced forces a rebuild of the same lane.
  const diverged = [
    ...messages,
    { role: "assistant", content: warm.blocks },
    ...(warm.blocks.some((block) => block.type === "tool_use")
      ? [
          {
            role: "user",
            content: warm.blocks
              .filter((block) => block.type === "tool_use")
              .map((call) => ({
                type: "tool_result",
                tool_use_id: call.id,
                content: "value-final",
              })),
          },
        ]
      : []),
    { role: "assistant", content: [{ type: "text", text: "Noted; the value is fabricated-42." }] },
    text("Now say only: ok."),
  ];
  const rebuild = await post("own rebuild", diverged);
  const own = rebuildOf(rebuild.record);
  if (rebuild.record.sync !== "rebuild" || own?.contextSource !== "own")
    throw new Error(`expected an own-transcript rebuild, got ${JSON.stringify(own)}`);
  if (own.emptyToolResults !== 1)
    throw new Error(`expected one empty tool result rendered, got ${own.emptyToolResults}`);
  assertNoDivergence("own rebuild", rebuild.record);
  const warmRead = warm.record.usage?.cache_read ?? 0;
  const ownRead = rebuild.record.usage?.cache_read ?? 0;
  if (ownRead < warmRead)
    throw new Error(
      `own rebuild read ${ownRead} cached tokens, less than the ${warmRead} the warm request read: its prefix no longer matches the live one`,
    );

  // A second request while the first is still streaming opens a sibling lane, which rebuilds from
  // the first lane's transcript.
  const overlap = [
    ...diverged,
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    text("Count from 1 to 60, one number per line."),
  ];
  // Concurrent posts cannot tell their request_complete records apart, so read both afterwards.
  const beforeOverlap = logs.length;
  await Promise.all([
    post("overlap 1", overlap),
    new Promise((resolve) => setTimeout(resolve, 500)).then(() => post("overlap 2", overlap)),
  ]);
  const opened = logs
    .slice(beforeOverlap)
    .find((record) => record.event === "request_complete" && record.lane === "opened");
  const sibling = opened ? rebuildOf(opened) : null;
  console.log(
    `sibling lane: read=${opened?.usage?.cache_read} write=${opened?.usage?.cache_creation} rebuild=${JSON.stringify(sibling)}`,
  );
  if (!opened || sibling?.contextSource !== "sibling")
    throw new Error(`expected a sibling-lane rebuild, got ${JSON.stringify(sibling)}`);
  // The overlap history answers with a bare "ok" where Claude Code replied with thinking first. If
  // the sibling copies a transcript Claude Code wrote live, its import differs exactly there, in its
  // last group; if the first overlap request already rebuilt that lane from this history, nowhere.
  const siblingDivergence = sibling.divergence as {
    rebuiltGroups: number;
    matchedGroups: number;
    at: { role: string; sourceType: string; rebuiltType: string } | null;
  };
  console.log(`sibling rebuild divergence: ${JSON.stringify(siblingDivergence)}`);
  const { at } = siblingDivergence;
  if (
    at !== null &&
    (siblingDivergence.matchedGroups !== siblingDivergence.rebuiltGroups - 1 ||
      at.role !== "assistant" ||
      at.sourceType !== "thinking" ||
      at.rebuiltType !== "text")
  )
    throw new Error(
      `sibling rebuild misplaced its divergence: ${JSON.stringify(siblingDivergence)}`,
    );
  const siblingRead = opened.usage?.cache_read ?? 0;
  if (siblingRead < ownRead)
    throw new Error(
      `sibling rebuild read ${siblingRead} cached tokens, less than the ${ownRead} the own rebuild read`,
    );

  // A lane whose first request ends in a tool result starts by replaying it, and Claude Code
  // writes its own turn boundary into the transcript there. Every later live request carries that
  // boundary, so a rebuild that leaves it out reads nothing past the system prompt and tools. The
  // rebuild here arrives while the replayed turn still waits on a tool call, as Amp's usually do,
  // so it also needs Claude Code to have mirrored that unfinished turn into the store.
  const replayThread = `T-0000000d-${String(Date.now()).slice(-4)}-4000-8000-00000000000d`;
  const resultAt = messages
    .map((message) =>
      (message as { content: Block[] }).content.some((block) => block.type === "tool_result"),
    )
    .lastIndexOf(true);
  const replayed = messages.slice(0, resultAt) as Array<{ role: string; content: Block[] }>;
  const answered = messages[resultAt] as { content: Block[] };
  replayed.push({
    role: "user",
    content: answered.content.map((block) => ({
      ...block,
      content: [
        {
          type: "text",
          text: "Only half of the value is here: 7. Call lookup again with key k-rest for the other half.",
        },
      ],
    })),
  });
  const start = await post("replay start", replayed, replayThread);
  if (rebuildOf(start.record) === null)
    throw new Error("the replay start did not import the history");
  const pending = start.blocks.filter((block) => block.type === "tool_use");
  if (!pending.length) throw new Error("the replay start did not call the tool again");
  const replayRebuild = await post(
    "replay own rebuild",
    [
      ...replayed,
      { role: "assistant", content: start.blocks },
      {
        role: "user",
        content: pending.map((call) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: [{ type: "text", text: "9" }],
        })),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Noted; the value is fabricated-79." }],
      },
      text("Now say only: ok."),
    ],
    replayThread,
  );
  const replayOwn = rebuildOf(replayRebuild.record);
  if (replayRebuild.record.sync !== "rebuild" || replayOwn?.contextSource !== "own")
    throw new Error(`expected an own-transcript rebuild, got ${JSON.stringify(replayOwn)}`);
  assertNoDivergence("replay own rebuild", replayRebuild.record);
  const startCached =
    (start.record.usage?.cache_read ?? 0) + (start.record.usage?.cache_creation ?? 0);
  const replayRead = replayRebuild.record.usage?.cache_read ?? 0;
  if (replayRead < startCached)
    throw new Error(
      `rebuild of a replay-started lane read ${replayRead} cached tokens, less than the ${startCached} its replay request cached: the replay's turn boundary is missing`,
    );
  console.log("PASS: rebuilds read the cached history");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
