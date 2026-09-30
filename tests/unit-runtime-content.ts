import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import type { CoreResponseEvent } from "doppelclaude/core-response";

const document: ContentBlockParam = {
  type: "document",
  source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" },
  title: "A PDF",
  context: "Keep this metadata",
  citations: { enabled: true },
};
const urlImage: ContentBlockParam = {
  type: "image",
  source: { type: "url", url: "https://example.com/image.png" },
};
const fileImage: ContentBlockParam = {
  type: "image",
  source: { type: "file", file_id: "file_image" },
};
const searchResult: ContentBlockParam = {
  type: "search_result",
  source: "https://example.com",
  title: "Result",
  content: [{ type: "text", text: "Search evidence" }],
};
const blocks = [
  { type: "text", text: "Read the attachment" },
  document,
  urlImage,
  fileImage,
  {
    type: "document",
    source: { type: "text", media_type: "text/plain", data: "Plain text source" },
  },
  { type: "document", source: { type: "content", content: [{ type: "text", text: "Paragraph" }] } },
  searchResult,
] satisfies ContentBlockParam[];

async function collect(stream: AsyncIterable<CoreResponseEvent>) {
  const events: CoreResponseEvent[] = [];
  for await (const event of stream) events.push(event);
  assert.equal(
    events.some((event) => event.type === "terminal_error"),
    false,
    JSON.stringify(events),
  );
  assert.ok(events.some((event) => event.type === "response"));
}

function harness(toolTurn = false, failAfterResult = false) {
  const prompts: SDKUserMessage[] = [];
  const transcripts: SessionStoreEntry[][] = [];
  let spawns = 0;
  let closes = 0;
  const runtime = createBridgeRuntime({
    queryFactory: ({ prompt, options }) => {
      spawns++;
      const callTool = toolTurn && spawns === 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (options?.resume && options.sessionStore) {
            transcripts.push(
              (await options.sessionStore.load({
                sessionId: options.resume,
                projectKey: "test",
              })) ?? [],
            );
          }
          for await (const input of prompt) {
            prompts.push(input);
            if (callTool) {
              const config = options?.mcpServers?.["custom-tools"] as {
                instance: { connect(transport: unknown): Promise<void> };
              };
              const client = new Client({ name: "content-test", version: "1" });
              const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
              await Promise.all([
                config.instance.connect(serverTransport),
                client.connect(clientTransport),
              ]);
              try {
                const result = client.callTool({
                  name: "read",
                  arguments: { path: "report.pdf" },
                  _meta: { "claudecode/toolUseId": "read_pdf" },
                });
                yield* [
                  {
                    type: "system",
                    subtype: "init",
                    session_id: "11111111-1111-4111-8111-111111111111",
                  },
                  {
                    type: "stream_event",
                    event: { type: "message_start", message: { usage: {} } },
                  },
                  {
                    type: "stream_event",
                    event: {
                      type: "content_block_start",
                      index: 0,
                      content_block: {
                        type: "tool_use",
                        id: "read_pdf",
                        name: "mcp__custom-tools__read",
                        input: {},
                      },
                    },
                  },
                  {
                    type: "stream_event",
                    event: {
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "input_json_delta", partial_json: '{"path":"report.pdf"}' },
                    },
                  },
                  { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
                  { type: "stream_event", event: { type: "message_stop" } },
                ] as unknown as SDKMessage[];
                await result;
                if (failAfterResult) throw new Error("Query closed before response received");
                return;
              } finally {
                await client.close();
              }
            }
            yield* [
              {
                type: "system",
                subtype: "init",
                session_id: options?.resume ?? "11111111-1111-4111-8111-111111111111",
              },
              { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
              {
                type: "stream_event",
                event: {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
              },
              {
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "done" },
                },
              },
              { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
              {
                type: "stream_event",
                event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
              },
              { type: "stream_event", event: { type: "message_stop" } },
              {
                type: "result",
                subtype: "success",
                result: "done",
                is_error: false,
                modelUsage: {},
              },
            ] as unknown as SDKMessage[];
          }
        },
        initializationResult: async () => ({}),
        setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
        setModel: async () => {},
        setMaxOutputTokens: async () => {},
        close: () => {
          closes++;
        },
      } as unknown as Query;
    },
  });
  return {
    runtime,
    prompts,
    transcripts,
    get spawns() {
      return spawns;
    },
    get closes() {
      return closes;
    },
    turn(messages: MessageParam[]) {
      return collect(
        runtime.turn({
          conversationKey: "test",
          model: "claude-haiku-4-5",
          cwd: process.cwd(),
          messages,
          tools: [{ name: "read", input_schema: { type: "object" } }],
        }),
      );
    },
  };
}

describe("native SDK content delivery", () => {
  it("preserves structured content on fresh and warm SDK prompts", async () => {
    const app = harness();
    await app.runtime.designateHost("test");
    try {
      const first: MessageParam[] = [{ role: "user", content: blocks }];
      await app.turn(first);
      await app.turn([
        ...first,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [document] },
      ]);
      assert.equal(app.spawns, 1);
      assert.deepEqual(
        app.prompts.map((prompt) => prompt.message.content),
        [blocks, [document]],
      );
    } finally {
      await app.runtime.clear("test complete");
    }
  });

  it("replays each non-MCP result independently, even without a PDF alongside it", async () => {
    const cases = [
      urlImage,
      fileImage,
      searchResult,
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "pixel" },
        transformations: { oversized_image: "error" },
      },
      {
        type: "text",
        text: "Cited",
        citations: [
          {
            type: "char_location",
            cited_text: "Cited",
            document_index: 0,
            document_title: "Source",
            start_char_index: 0,
            end_char_index: 5,
          },
        ],
      },
    ] satisfies ContentBlockParam[];
    for (const block of cases) {
      const app = harness();
      await app.runtime.designateHost("test");
      try {
        await app.turn([
          { role: "user", content: "Read" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "read", name: "read", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "read", content: [block] }],
          },
        ]);
        assert.equal(app.spawns, 1);
        const result = app.transcripts[0].find(
          (entry) =>
            entry.type === "user" && Array.isArray((entry.message as MessageParam).content),
        );
        assert.ok(result);
        assert.deepEqual((result.message as MessageParam).content, [
          { type: "tool_result", tool_use_id: "read", content: [block] },
        ]);
      } finally {
        await app.runtime.clear("test complete");
      }
    }
  });

  for (const warm of [false, true]) {
    for (const steering of ["none", "mixed", "split"]) {
      it(`imports complete ${warm ? "warm" : "cold"} tool results with ${steering} steering`, async () => {
        const app = harness(warm);
        await app.runtime.designateHost("test");
        try {
          if (warm) {
            await app.turn([{ role: "user", content: "Read the PDF" }]);
          }
          const messages: MessageParam[] = [
            { role: "user", content: "Read the PDF" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Signed reasoning", signature: "signature" },
                { type: "redacted_thinking", data: "opaque" },
                { type: "tool_use", id: "read_pdf", name: "read", input: { path: "report.pdf" } },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "read_pdf",
                  content: blocks,
                },
                ...(steering === "mixed"
                  ? [{ type: "text" as const, text: "Focus on page two" }]
                  : []),
              ],
            },
            ...(steering === "split"
              ? [{ role: "user" as const, content: "Focus on page two" }]
              : []),
          ];
          await app.turn(messages);
          assert.equal(app.spawns, warm ? 2 : 1);
          assert.equal(app.closes, warm ? 1 : 0);
          const imported = app.transcripts
            .at(-1)
            ?.filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => {
              const message = entry.message as MessageParam;
              return { role: message.role, content: message.content };
            });
          const expected =
            steering === "mixed"
              ? [
                  ...messages.slice(0, 2),
                  {
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: "read_pdf", content: blocks }],
                  },
                  { role: "user", content: [{ type: "text", text: "Focus on page two" }] },
                ]
              : messages;
          assert.deepEqual(imported, expected);
          await app.turn([
            ...messages,
            { role: "assistant", content: [{ type: "text", text: "done" }] },
            { role: "user", content: "Continue" },
          ]);
          assert.equal(app.spawns, warm ? 2 : 1, "the PDF history must not poison later turns");
        } finally {
          await app.runtime.clear("test complete");
        }
      });
    }
  }

  it("keeps mixed tool results in the transcript when a dead query retries steering", async () => {
    const app = harness(true, true);
    await app.runtime.designateHost("test");
    try {
      await app.turn([{ role: "user", content: "Read the PDF" }]);
      await app.turn([
        { role: "user", content: "Read the PDF" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "read_pdf", name: "read", input: { path: "report.pdf" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "read_pdf", content: "cobalt-heron-731" },
            { type: "text", text: "Return the code only" },
          ],
        },
      ]);
      assert.equal(app.spawns, 2);
      const imported = app.transcripts.at(-1)?.filter((entry) => entry.type === "user");
      const result = imported?.at(-1)?.message;
      assert.ok(result);
      assert.deepEqual((result as MessageParam).content, [
        { type: "tool_result", tool_use_id: "read_pdf", content: "cobalt-heron-731" },
      ]);
      assert.deepEqual(app.prompts.at(-1)?.message.content, [
        { type: "text", text: "Return the code only" },
      ]);
    } finally {
      await app.runtime.clear("test complete");
    }
  });
});
