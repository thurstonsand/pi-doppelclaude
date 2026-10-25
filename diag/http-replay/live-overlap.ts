// Runs the three overlap scenarios against a given HTTP server module on real Claude Code and
// prints each request's status and request_complete decision. See README.md.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { server: { type: "string" }, model: { type: "string", default: "claude-haiku-4-5" } },
});
if (!values.server) throw new Error("usage: live-overlap.ts --server <server.ts>");
const { createHttpServer } = (await import(
  values.server
)) as typeof import("../../packages/http-doppelclaude/src/server.ts");

const logs: Array<Record<string, unknown>> = [];
const server = createHttpServer({
  apiKey: "live",
  supportedModels: [],
  stateDir: await mkdtemp(join(tmpdir(), "doppelclaude-live-")),
  log: (record) => logs.push(record),
});
server.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no address");
const port = address.port;

const thread = (n: number) =>
  `T-0000000${n}-${String(Date.now()).slice(-4)}-4000-8000-${"0".repeat(11)}${n}`;
// Large enough to cross the prompt-cache minimum, so cache reads show whether a rebuild kept it.
const filler = Array.from(
  { length: 400 },
  (_, i) => `Reference note ${i}: the bridge keeps state.`,
).join("\n");
const lookup = {
  name: "lookup",
  description: "Look up a value.",
  input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
};
function main(id: string, messages: unknown[]) {
  return {
    model: values.model,
    max_tokens: 1024,
    stream: true,
    system: `You are the main agent.\n${filler}\nAmp Thread URL: https://ampcode.com/threads/${id}`,
    tools: [lookup],
    messages,
  };
}
function oracle(id: string, question: string) {
  return {
    model: values.model,
    max_tokens: 256,
    stream: true,
    system: `You are an advisor. Answer in one sentence.\n${filler}\nAmp Thread URL: https://ampcode.com/threads/${id}`,
    messages: [{ role: "user", content: question }],
  };
}
const claimed = new Set<Record<string, unknown>>();
async function post(label: string, body: unknown) {
  const before = logs.length;
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "live" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const mine = (entry: Record<string, unknown>) =>
    entry.event === "request_complete" &&
    !claimed.has(entry) &&
    (response.status === 200 ? entry.outcome === "success" : entry.httpStatus === response.status);
  for (let tries = 0; tries < 100 && !logs.slice(before).some(mine); tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const record = logs.slice(before).find(mine);
  if (record) claimed.add(record);
  let reply = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6)) as {
      type: string;
      delta?: { type: string; text?: string };
    };
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta")
      reply += event.delta.text;
  }
  const executions = (record?.executions as Array<{ event: string }> | null) ?? [];
  const usage = record?.usage as Record<string, unknown> | undefined;
  const row = {
    label,
    status: response.status,
    reason: record?.reason ?? null,
    lane: record?.lane ?? null,
    threadRuntimes: record?.threadRuntimes ?? null,
    coldReplay: record?.coldReplay ?? null,
    query: executions.find((event) => event.event.startsWith("query_"))?.event ?? null,
    cacheRead: usage?.cache_read ?? null,
    cacheCreation: usage?.cache_creation ?? null,
    error: response.status === 200 ? null : text.slice(0, 120),
    reply: reply.slice(0, 60),
  };
  console.log(JSON.stringify(row));
  return { row, reply };
}
const user = (content: string) => ({ role: "user", content });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

try {
  console.log(JSON.stringify({ scenario: "main → Oracle → main" }));
  const a = thread(1);
  const first = await post("main 1", main(a, [user("Reply with the word READY.")]));
  await post("oracle", oracle(a, "Is the sky blue? Answer yes or no."));
  await post(
    "main 2",
    main(a, [
      user("Reply with the word READY."),
      assistant(first.reply),
      user("Reply with the word AGAIN."),
    ]),
  );

  console.log(JSON.stringify({ scenario: "parallel Oracles" }));
  const b = thread(2);
  await post("main", main(b, [user("Reply with the word READY.")]));
  await Promise.all([
    post("oracle B", oracle(b, "Is water wet? Answer yes or no.")),
    post("oracle C", oracle(b, "Is fire hot? Answer yes or no.")),
  ]);

  console.log(JSON.stringify({ scenario: "retry while the first request still runs" }));
  const c = thread(3);
  const slow = main(c, [user("Count from 1 to 150, separated by spaces, then stop.")]);
  const original = post("original", slow);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const retry = await post("retry", slow);
  await original;
  await post(
    "next",
    main(c, [
      user("Count from 1 to 150, separated by spaces, then stop."),
      assistant(retry.reply),
      user("Reply with the word DONE."),
    ]),
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
