import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const baseUrl = process.env.DOPPELCLAUDE_HTTP_URL ?? "http://127.0.0.1:3456";
const keyFile = process.env.DOPPELCLAUDE_HTTP_API_KEY_FILE;
if (!keyFile) throw new Error("set DOPPELCLAUDE_HTTP_API_KEY_FILE");
const apiKey = (await readFile(keyFile, "utf8")).trim();
if (!apiKey) throw new Error("HTTP API key file is blank");
const model = process.env.DOPPELCLAUDE_HTTP_CLIENT_MODEL ?? "claude-haiku-4-5";
const threads = [
  { id: "T-a1111111-1111-4111-8111-111111111111", expected: "ALPHA_17", sibling: "BRAVO_92" },
  { id: "T-b2222222-2222-4222-8222-222222222222", expected: "BRAVO_92", sibling: "ALPHA_17" },
];

type Block = Record<string, unknown> & { type: string };
type Message = { role: "user" | "assistant"; content: string | Block[] };

async function turn(
  threadId: string,
  messages: Message[],
): Promise<{ content: Block[]; cacheRead: number }> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      system: `Diagnostic only.\nAmp Thread URL: https://ampcode.com/threads/${threadId}`,
      tools: [
        {
          name: "echo_token",
          description: "Return a diagnostic token supplied by the client.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      messages,
    }),
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw.slice(0, 500));
  const events = raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const blocks = new Map<number, Block>();
  let cacheRead = 0;
  for (const event of events) {
    if (event.type === "error") throw new Error(JSON.stringify(event.error));
    if (event.type === "content_block_start") {
      const index = event.index as number;
      blocks.set(index, structuredClone(event.content_block) as Block);
    } else if (event.type === "content_block_delta") {
      const block = blocks.get(event.index as number);
      const delta = event.delta as Record<string, string>;
      assert.ok(block);
      if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
      if (delta.type === "thinking_delta")
        block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
      if (delta.type === "signature_delta") block.signature = delta.signature;
      if (delta.type === "input_json_delta")
        block._json = `${block._json ?? ""}${delta.partial_json}`;
    } else if (event.type === "message_delta") {
      cacheRead = Number((event.usage as Record<string, number>).cache_read_input_tokens ?? 0);
    }
  }
  const content = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) => {
      if (block.type === "tool_use") {
        block.input = JSON.parse(String(block._json || "{}"));
        delete block._json;
      }
      return block;
    });
  return { content, cacheRead };
}

const initial: Message[] = [
  {
    role: "user",
    content:
      "Call the explicitly named echo_token tool exactly once. After its result, reply with exactly that result token.",
  },
];
const first = await Promise.all(threads.map((thread) => turn(thread.id, initial)));
for (const [index, result] of first.entries()) {
  const call = result.content.find((block) => block.type === "tool_use");
  assert.equal(call?.name, "echo_token", `thread ${index} did not call echo_token`);
  call.id = `client-renamed-${index + 1}`;
}
const continued = await Promise.all(
  threads.map((thread, index) =>
    turn(thread.id, [
      ...initial,
      { role: "assistant", content: first[index].content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `client-renamed-${index + 1}`,
            content: thread.expected,
          },
        ],
      },
    ]),
  ),
);
for (const [index, thread] of threads.entries()) {
  const text = continued[index].content.map((block) => String(block.text ?? "")).join("");
  assert.match(text, new RegExp(thread.expected));
  assert.doesNotMatch(text, new RegExp(thread.sibling));
}
process.stdout.write(`${JSON.stringify({ phase: "tool-continuation", ok: true })}\n`);
const warm = await Promise.all(
  threads.map((thread, index) =>
    turn(thread.id, [
      ...initial,
      { role: "assistant", content: first[index].content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `client-renamed-${index + 1}`,
            content: thread.expected,
          },
        ],
      },
      { role: "assistant", content: continued[index].content },
      { role: "user", content: "Repeat the same token exactly." },
    ]),
  ),
);
for (const [index, thread] of threads.entries()) {
  for (const result of [continued[index], warm[index]]) {
    const text = result.content.map((block) => String(block.text ?? "")).join("");
    assert.match(text, new RegExp(thread.expected));
    assert.doesNotMatch(text, new RegExp(thread.sibling));
  }
}
process.stdout.write(
  `${JSON.stringify({ ok: true, model, threads: threads.map((thread, index) => ({ id: thread.id, continuationCacheRead: continued[index].cacheRead, warmCacheRead: warm[index].cacheRead })) }, null, 2)}\n`,
);
