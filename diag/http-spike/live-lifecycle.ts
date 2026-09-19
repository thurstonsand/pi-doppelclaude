import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { query, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { createHttpServer } from "http-doppelclaude";

const configuredModel = process.env.DOPPELCLAUDE_HTTP_CLIENT_MODEL ?? "claude-opus-4-6";
if (
  configuredModel !== "claude-haiku-4-5" &&
  configuredModel !== "claude-opus-4-6" &&
  configuredModel !== "claude-opus-5"
)
  throw new Error("unsupported DOPPELCLAUDE_HTTP_CLIENT_MODEL");
const MODEL: "claude-haiku-4-5" | "claude-opus-4-6" | "claude-opus-5" = configuredModel;

const TURN_TIMEOUT_MS = 120_000;
const tool = {
  name: "echo_lifecycle_value",
  description: "Return a lifecycle diagnostic value supplied by the client.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};
type Block = Record<string, unknown> & { type: string };
type Message = { role: "user" | "assistant"; content: string | Block[] };
type RunningServer = { server: Server; url: string; key: string };
const importedTranscripts: Array<Promise<SessionStoreEntry[] | null>> = [];

const threadId = () => `T-${randomUUID()}`;
const system = (id: string) =>
  `Synthetic HTTP lifecycle diagnostic, not an Amp app workflow.\nAmp Thread URL: https://ampcode.com/threads/${id}`;
const textOf = (blocks: Block[]) =>
  blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
const evidence = (scenario: string, details: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ scenario, ok: true, ...details })}\n`);

async function startServer(): Promise<RunningServer> {
  const key = randomUUID();
  const server = createHttpServer({
    apiKey: key,
    supportedModels: [],
    queryFactory(request) {
      const { options } = request;
      if (options?.resume && options.sessionStore) {
        importedTranscripts.push(
          options.sessionStore.load({ sessionId: options.resume, projectKey: process.cwd() }),
        );
      }
      return query(request);
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}`, key };
}

async function closeServer(running: RunningServer): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) =>
        running.server.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("timed out closing HTTP spike server")),
          20_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function turn(
  running: RunningServer,
  id: string,
  messages: Message[],
  options: { tools?: (typeof tool)[]; abortAfterText?: boolean; pollConflict?: boolean } = {},
): Promise<{ blocks: Block[]; stopReason?: string; aborted: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("HTTP lifecycle turn timed out")),
    TURN_TIMEOUT_MS,
  );
  const blocks = new Map<number, Block>();
  let buffer = "";
  let stopReason: string | undefined;
  let terminal = false;
  let aborted = false;
  try {
    const deadline = Date.now() + 10_000;
    let response: Response;
    while (true) {
      response = await fetch(`${running.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": running.key },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          stream: true,
          system: system(id),
          tools: options.tools ?? [],
          messages,
        }),
        signal: controller.signal,
      });
      if (!(options.pollConflict && response.status === 409 && Date.now() < deadline)) break;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (response.status !== 200)
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (event.type === "error") throw new Error(`SSE error: ${JSON.stringify(event.error)}`);
        if (event.type === "content_block_start")
          blocks.set(event.index as number, structuredClone(event.content_block) as Block);
        if (event.type === "content_block_delta") {
          const block = blocks.get(event.index as number);
          assert.ok(block);
          const delta = event.delta as Record<string, string>;
          if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
          if (delta.type === "thinking_delta")
            block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
          if (delta.type === "signature_delta") block.signature = delta.signature;
          if (delta.type === "input_json_delta")
            block._json = `${block._json ?? ""}${delta.partial_json}`;
          if (
            options.abortAfterText &&
            delta.type === "text_delta" &&
            String(block.text).length > 0
          ) {
            aborted = true;
            controller.abort();
          }
        }
        if (event.type === "message_delta")
          stopReason = (event.delta as { stop_reason?: string }).stop_reason;
        if (event.type === "message_stop") terminal = true;
      }
    }
  } catch (error) {
    const expectedAbort =
      aborted &&
      (error === controller.signal.reason ||
        (error instanceof Error && error.name === "AbortError"));
    if (!expectedAbort) throw error;
  } finally {
    clearTimeout(timeout);
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
  if (options.abortAfterText) {
    assert.ok(aborted, "stream completed before the diagnostic could abort it");
    assert.ok(!terminal, "stream reached message_stop before the diagnostic aborted it");
    assert.ok(textOf(content).length > 0, "abort happened before text content arrived");
  } else {
    assert.ok(terminal, "SSE stream ended without message_stop");
    assert.ok(stopReason, "SSE stream ended without a terminal stop reason");
  }
  return { blocks: content, stopReason, aborted };
}

let running = await startServer();
try {
  const originalThread = threadId();
  const toolPrompt: Message[] = [
    {
      role: "user",
      content:
        "Call echo_lifecycle_value exactly once. After its result, reply with exactly the result and no other text.",
    },
  ];
  const called = await turn(running, originalThread, toolPrompt, { tools: [tool] });
  assert.equal(called.stopReason, "tool_use");
  const call = called.blocks.find((block) => block.type === "tool_use");
  assert.equal(call?.name, tool.name);
  const renamedId = `renamed-${randomUUID()}`;
  if (call) call.id = renamedId;
  const restartValue = `RESTART_${randomUUID()}`;
  const completedHistory: Message[] = [
    ...toolPrompt,
    { role: "assistant", content: called.blocks },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: renamedId, content: restartValue }],
    },
  ];
  await closeServer(running);
  running = await startServer();
  const replayed = await turn(running, originalThread, completedHistory, { tools: [tool] });
  assert.match(textOf(replayed.blocks), new RegExp(restartValue));
  completedHistory.push({ role: "assistant", content: replayed.blocks });
  evidence("restart-pending-tool", { model: MODEL, renamedId: true, resultUsed: true });

  const importedThread = threadId();
  const originalFollowup = `ORIGINAL_${randomUUID()}`;
  const importedFollowup = `IMPORTED_${randomUUID()}`;
  const originalPrompt: Message = {
    role: "user",
    content: `Store branch value ${originalFollowup}. Reply exactly ${originalFollowup}`,
  };
  const importedPrompt: Message = {
    role: "user",
    content: `Store branch value ${importedFollowup}. Reply exactly ${importedFollowup}`,
  };
  const [originalAnswer, importedAnswer] = await Promise.all([
    turn(running, originalThread, [...completedHistory, originalPrompt]),
    turn(running, importedThread, [...completedHistory, importedPrompt]),
  ]);
  assert.match(textOf(originalAnswer.blocks), new RegExp(originalFollowup));
  assert.doesNotMatch(textOf(originalAnswer.blocks), new RegExp(importedFollowup));
  assert.match(textOf(importedAnswer.blocks), new RegExp(importedFollowup));
  assert.doesNotMatch(textOf(importedAnswer.blocks), new RegExp(originalFollowup));
  const [originalRecall, importedRecall] = await Promise.all([
    turn(running, originalThread, [
      ...completedHistory,
      originalPrompt,
      { role: "assistant", content: originalAnswer.blocks },
      { role: "user", content: "Reply with exactly the stored branch value." },
    ]),
    turn(running, importedThread, [
      ...completedHistory,
      importedPrompt,
      { role: "assistant", content: importedAnswer.blocks },
      { role: "user", content: "Reply with exactly the stored branch value." },
    ]),
  ]);
  assert.equal(textOf(originalRecall.blocks).trim(), originalFollowup);
  assert.doesNotMatch(textOf(originalRecall.blocks), new RegExp(importedFollowup));
  assert.equal(textOf(importedRecall.blocks).trim(), importedFollowup);
  assert.doesNotMatch(textOf(importedRecall.blocks), new RegExp(originalFollowup));
  evidence("synthetic-history-import", { distinctThreadIds: true, isolatedRecall: true });

  const compactedThread = threadId();
  const earlierValue = `EARLIER_${randomUUID()}`;
  const earlierPrompt: Message = {
    role: "user",
    content: `Remember ${earlierValue}. Reply exactly ACK.`,
  };
  const earlierAnswer = await turn(running, compactedThread, [earlierPrompt]);
  const oldHistory: Message[] = [
    earlierPrompt,
    { role: "assistant", content: earlierAnswer.blocks },
    { role: "user", content: "Keep remembering the value. Reply exactly ACK." },
  ];
  const secondAnswer = await turn(running, compactedThread, oldHistory);
  oldHistory.push({ role: "assistant", content: secondAnswer.blocks });
  const replacementValue = `REPLACED_${randomUUID()}`;
  const replacementCapture = importedTranscripts.length;
  const replaced = await turn(running, compactedThread, [
    {
      role: "user",
      content:
        `Synthetic summary-like replacement: the authoritative value is ${replacementValue}. ` +
        "All earlier values are obsolete.",
    },
    { role: "assistant", content: "Understood." },
    { role: "user", content: "Reply with exactly the authoritative value." },
  ]);
  assert.equal(textOf(replaced.blocks).trim(), replacementValue);
  assert.doesNotMatch(textOf(replaced.blocks), new RegExp(earlierValue));
  const replacementImports = await Promise.all(importedTranscripts.slice(replacementCapture));
  assert.equal(replacementImports.length, 1);
  const replacementTranscript = JSON.stringify(replacementImports[0]);
  assert.doesNotMatch(replacementTranscript, new RegExp(earlierValue));
  assert.match(replacementTranscript, new RegExp(replacementValue));
  evidence("synthetic-summary-replacement", {
    sameKey: true,
    shorterHistoryReplaced: true,
    importedTranscriptCount: replacementImports.length,
  });

  const abortedThread = threadId();
  const baselineValue = `BASE_${randomUUID()}`;
  const baselinePrompt: Message = { role: "user", content: `Reply exactly ${baselineValue}` };
  const baseline = await turn(running, abortedThread, [baselinePrompt]);
  const authoritative: Message[] = [
    baselinePrompt,
    { role: "assistant", content: baseline.blocks },
  ];
  const interruptedRequest = `INTERRUPTED_${randomUUID()}`;
  await turn(
    running,
    abortedThread,
    [
      ...authoritative,
      {
        role: "user",
        content: `Include ${interruptedRequest} while writing at least twenty paragraphs about HTTP streaming.`,
      },
    ],
    { abortAfterText: true },
  );
  const recoveryValue = `RECOVERED_${randomUUID()}`;
  const recoveryCapture = importedTranscripts.length;
  const recovered = await turn(
    running,
    abortedThread,
    [
      ...authoritative,
      {
        role: "user",
        content: `Ignore any interrupted response and reply exactly ${recoveryValue}`,
      },
    ],
    { pollConflict: true },
  );
  assert.match(textOf(recovered.blocks), new RegExp(recoveryValue));
  const recoveryImports = await Promise.all(importedTranscripts.slice(recoveryCapture));
  assert.equal(recoveryImports.length, 1);
  const recoveryTranscript = JSON.stringify(recoveryImports[0]);
  assert.doesNotMatch(recoveryTranscript, new RegExp(interruptedRequest));
  assert.match(recoveryTranscript, new RegExp(baselineValue));
  evidence("aborted-stream-recovery", {
    contentBeforeAbort: true,
    authoritativeHistoryRecovered: true,
    importedTranscriptCount: recoveryImports.length,
  });
} finally {
  await closeServer(running);
}
