#!/usr/bin/env node

// Unit tests for pi→Anthropic message conversion (convert.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Context, Model, Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { mapPiToolNameToSdk, mapSdkToolNameToPi } from "doppelclaude/tool-names";
import { convertPiMessages } from "pi-doppelclaude/convert";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { record } from "./lib/turns.js";

// Narrow a converted message's content to its block array. The converter returns
// cc-session-io's `string | ContentBlock[]` union; the block-indexing tests only
// run on messages the converter builds as block arrays.
function blocks(message: SessionMessage): ContentBlock[] {
  assert.ok(
    Array.isArray(message.content),
    `expected block content, got ${JSON.stringify(message.content)}`,
  );
  return message.content;
}

// Narrow a converted block to a concrete discriminant so assertions can read its
// variant-specific fields (text, id, tool_use_id, ...) without a cast.
function block<T extends ContentBlock["type"]>(
  message: SessionMessage,
  index: number,
  type: T,
): Extract<ContentBlock, { type: T }> {
  const found = blocks(message)[index];
  assert.equal(found.type, type);
  return found as Extract<ContentBlock, { type: T }>;
}

// Shorthand: convert loose pi-message fixtures and return just the anthropic
// messages. Fixtures are minimal by design, so they enter the real converter
// through its `Message[]` boundary.
function convert(messages: unknown[], customToolNameToSdk?: Map<string, string>): SessionMessage[] {
  return convertPiMessages(messages as PiMessage[], customToolNameToSdk).anthropicMessages;
}

// --- Tests ---

describe("SDK tool conversion", () => {
  const registered = new Map([
    ["mcp__custom-tools__SlowTool", "SlowTool"],
    ["mcp__custom-tools__slowtool", "SlowTool"],
    ["mcp__custom-tools__bash", "bash"],
  ]);

  it("maps registered MCP tool names to pi", () => {
    assert.equal(mapSdkToolNameToPi("mcp__custom-tools__SlowTool", registered), "SlowTool");
    assert.equal(mapSdkToolNameToPi("mcp__custom-tools__bash", registered), "bash");
  });

  it("mangles every unregistered name, including CC built-ins and near misses", () => {
    assert.equal(mapSdkToolNameToPi("bash", registered), "cc_no_such_tool__bash");
    assert.equal(mapSdkToolNameToPi("Read", registered), "cc_no_such_tool__Read");
    assert.equal(
      mapSdkToolNameToPi("mcp__custom-tools__bassh", registered),
      "cc_no_such_tool__mcp__custom-tools__bassh",
    );
    assert.equal(mapSdkToolNameToPi("anything"), "cc_no_such_tool__anything");
  });

  it("materializes a mangled name back to the literal CC name", () => {
    assert.equal(mapPiToolNameToSdk("cc_no_such_tool__bash"), "bash");
    assert.equal(
      mapPiToolNameToSdk("cc_no_such_tool__mcp__custom-tools__bassh"),
      "mcp__custom-tools__bassh",
    );
  });

  it("round-trips a rejected call through pi history", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "toolu_1",
            name: "cc_no_such_tool__bash",
            arguments: { command: "ls" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        content: "Tool cc_no_such_tool__bash not found",
        isError: true,
      },
    ];
    const result = convert(msgs);
    const use = block(result[0], 0, "tool_use");
    assert.equal(use.name, "bash");
    assert.deepEqual(use.input, { command: "ls" });
    assert.equal(block(result[1], 0, "tool_result").is_error, true);
  });
});

describe("runtime rebuild tool names", () => {
  const [model] = projectCatalogModels(
    [
      {
        id: "claude-haiku-4-5",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        contextWindow: 200_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as unknown as Model<Api>,
    ],
    new Set(["claude-haiku-4-5"]),
  );

  async function importedToolName(piName: string): Promise<string> {
    let loaded: Promise<unknown> | undefined;
    const runtime = createBridgeRuntime({
      providerSettings: { systemPromptMode: "claude-code" },
      queryFactory: ({ options }) => {
        assert.ok(options?.resume);
        assert.ok(options.sessionStore);
        loaded = options.sessionStore.load({
          sessionId: options.resume,
          projectKey: process.cwd(),
        });
        const messages = [
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
              delta: { type: "text_delta", text: "ok" },
            },
          },
          { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
          {
            type: "stream_event",
            event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
          },
          { type: "stream_event", event: { type: "message_stop" } },
          { type: "result", subtype: "success", result: "", is_error: false, modelUsage: {} },
        ] as unknown as SDKMessage[];
        return {
          async *[Symbol.asyncIterator]() {
            yield* messages;
          },
          initializationResult: async () => ({}),
          setMcpServers: async () => ({
            added: [] as string[],
            removed: [] as string[],
            errors: {},
          }),
          setModel: async () => {},
          interrupt: async () => ({}),
          close: () => {},
        } as unknown as Query;
      },
    });
    void runtime.designateHost("host");
    const context = {
      systemPrompt: "",
      tools: [
        {
          name: "LookUp",
          description: "Look something up",
          parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [] as Array<{ type: "text"; text: string }> }),
        },
      ],
      messages: [
        { role: "user", content: "use it" },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call.1", name: piName, arguments: {} }],
        },
        { role: "toolResult", toolCallId: "call.1", toolName: piName, content: "done" },
        { role: "user", content: "continue" },
      ],
    } as unknown as Context;

    await record(runtime.stream(model, context, { sessionId: "guest" })).done;
    assert.ok(loaded, "query did not load the rebuilt transcript");
    const entries = (await loaded) as Array<{ message?: { content?: ContentBlock[] } }>;
    const toolUse = entries
      .flatMap((entry) => entry.message?.content ?? [])
      .find((candidate) => candidate.type === "tool_use");
    assert.ok(toolUse && toolUse.type === "tool_use");
    return toolUse.name;
  }

  it("uses served casing for a historical lowercase lookup", async () => {
    assert.equal(await importedToolName("lookup"), "mcp__custom-tools__LookUp");
  });

  it("preserves a rejected Claude Code tool as its native name", async () => {
    assert.equal(await importedToolName("cc_no_such_tool__bash"), "bash");
  });
});

describe("tool ID sanitization", () => {
  it("Kimi-style IDs with dots and colons", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "functions.bash:0", name: "bash", arguments: { cmd: "ls" } },
        ],
      },
      { role: "toolResult", toolCallId: "functions.bash:0", content: "file.txt" },
    ];
    const result = convert(msgs);
    assert.equal(block(result[0], 0, "tool_use").id, "functions_bash_0");
    assert.equal(block(result[1], 0, "tool_result").tool_use_id, "functions_bash_0");
  });

  it("IDs with spaces and special chars", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool call#1@foo", name: "bash", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "tool call#1@foo", content: "ok" },
    ];
    const result = convert(msgs);
    assert.equal(block(result[0], 0, "tool_use").id, "tool_call_1_foo");
    assert.equal(block(result[1], 0, "tool_result").tool_use_id, "tool_call_1_foo");
  });

  it("already-valid Anthropic IDs pass through unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_abc123-XYZ", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "toolu_abc123-XYZ", content: "data" },
    ];
    const result = convert(msgs);
    assert.equal(block(result[0], 0, "tool_use").id, "toolu_abc123-XYZ");
    assert.equal(block(result[1], 0, "tool_result").tool_use_id, "toolu_abc123-XYZ");
  });

  it("tool_use and tool_result IDs stay paired after sanitization", () => {
    const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"];
    const msgs = [];
    for (const id of ids) {
      msgs.push({
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
      });
      msgs.push({ role: "toolResult", toolCallId: id, content: "ok" });
    }
    const result = convert(msgs);
    for (let i = 0; i < ids.length; i++) {
      const useId = block(result[i * 2], 0, "tool_use").id;
      const resultId = block(result[i * 2 + 1], 0, "tool_result").tool_use_id;
      assert.equal(useId, resultId, `pair ${i}: tool_use=${useId} tool_result=${resultId}`);
    }
  });
});

describe("empty text block filtering", () => {
  it("assistant with empty text + toolCall → only toolCall", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "toolCall", id: "abc", name: "read", arguments: {} },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 1);
    assert.equal(blocks(result[0]).length, 1);
    assert.equal(blocks(result[0])[0].type, "tool_use");
  });

  it("assistant with only empty text → placeholder", () => {
    const msgs = [{ role: "assistant", content: [{ type: "text", text: "" }] }];
    const result = convert(msgs);
    assert.equal(result.length, 1);
    assert.equal(block(result[0], 0, "text").text, "[incompatible content omitted]");
  });

  it("assistant with non-empty text → preserved", () => {
    const msgs = [{ role: "assistant", content: [{ type: "text", text: "Hello world" }] }];
    const result = convert(msgs);
    assert.equal(result.length, 1);
    assert.equal(block(result[0], 0, "text").text, "Hello world");
  });

  it("assistant with multiple text blocks, some empty", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real content" },
          { type: "text", text: "" },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 1);
    assert.equal(blocks(result[0]).length, 1);
    assert.equal(block(result[0], 0, "text").text, "real content");
  });
});

describe("thinking block filtering", () => {
  it("non-Anthropic provider thinking blocks dropped", () => {
    const msgs = [
      {
        role: "assistant",
        provider: "openrouter",
        content: [
          { type: "thinking", thinking: "let me think..." },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 1);
    assert.equal(blocks(result[0]).length, 1);
    assert.equal(blocks(result[0])[0].type, "text");
  });

  it("Anthropic provider thinking with signature preserved", () => {
    const msgs = [
      {
        role: "assistant",
        provider: "doppelclaude",
        content: [
          { type: "thinking", thinking: "reasoning...", thinkingSignature: "sig123" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(blocks(result[0]).length, 2);
    assert.equal(block(result[0], 0, "thinking").signature, "sig123");
  });

  it("Anthropic provider via api field", () => {
    const msgs = [
      {
        role: "assistant",
        api: "anthropic-messages",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig456" },
          { type: "text", text: "done" },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(blocks(result[0]).length, 2);
    assert.equal(blocks(result[0])[0].type, "thinking");
  });

  it("Anthropic provider thinking WITHOUT signature → dropped", () => {
    const msgs = [
      {
        role: "assistant",
        provider: "doppelclaude",
        content: [
          { type: "thinking", thinking: "no sig" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(blocks(result[0]).length, 1);
    assert.equal(blocks(result[0])[0].type, "text");
  });

  it("assistant with only thinking (non-Anthropic) → placeholder", () => {
    const msgs = [
      {
        role: "assistant",
        provider: "deepseek",
        content: [{ type: "thinking", thinking: "deep thoughts" }],
      },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 1);
    assert.equal(block(result[0], 0, "text").text, "[incompatible content omitted]");
  });
});

describe("message structure", () => {
  it("toolResult → user with tool_result content", () => {
    const msgs = [
      { role: "toolResult", toolCallId: "id1", content: "result text", isError: false },
    ];
    const result = convert(msgs);
    assert.equal(result[0].role, "user");
    const toolResult = block(result[0], 0, "tool_result");
    assert.equal(toolResult.tool_use_id, "id1");
    assert.equal(toolResult.content, "result text");
    assert.equal(toolResult.is_error, false);
  });

  it("toolResult with isError=true", () => {
    const msgs = [{ role: "toolResult", toolCallId: "id1", content: "oh no", isError: true }];
    assert.equal(block(convert(msgs)[0], 0, "tool_result").is_error, true);
  });

  it("parallel tool results collect into one user message", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
          { type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "content a" },
      { role: "toolResult", toolCallId: "t2", content: "content b" },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, "assistant");
    assert.equal(blocks(result[0]).length, 2);
    assert.equal(result[1].role, "user");
    assert.equal(blocks(result[1]).length, 2);
    assert.equal(block(result[1], 0, "tool_result").tool_use_id, "t1");
    assert.equal(block(result[1], 1, "tool_result").tool_use_id, "t2");
  });

  it("a steer between parallel results hoists the results above it", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
          { type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "content a" },
      { role: "user", content: "actually, check c.txt too" },
      { role: "toolResult", toolCallId: "t2", content: "content b" },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 3);
    assert.equal(result[1].role, "user");
    assert.equal(block(result[1], 0, "tool_result").tool_use_id, "t1");
    assert.equal(block(result[1], 1, "tool_result").tool_use_id, "t2");
    assert.equal(result[2].content, "actually, check c.txt too");
  });

  it("a steer before the first result still lands after the turn's results", () => {
    const msgs = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 60" } }],
      },
      { role: "user", content: "never mind, stop" },
      { role: "toolResult", toolCallId: "t1", content: "done" },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 3);
    assert.equal(block(result[1], 0, "tool_result").tool_use_id, "t1");
    assert.equal(result[2].content, "never mind, stop");
  });

  it("mixed conversation: user → assistant(tool) → toolResult → assistant(text)", () => {
    const msgs = [
      { role: "user", content: "read file.txt" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "file.txt" } }],
      },
      { role: "toolResult", toolCallId: "call1", content: "hello world" },
      { role: "assistant", content: [{ type: "text", text: "The file says hello world." }] },
    ];
    const result = convert(msgs);
    assert.equal(result.length, 4);
    assert.equal(result[0].role, "user");
    assert.equal(result[0].content, "read file.txt");
    assert.equal(result[1].role, "assistant");
    assert.equal(block(result[1], 0, "tool_use").name, "mcp__custom-tools__read");
    assert.equal(result[2].role, "user");
    assert.equal(blocks(result[2])[0].type, "tool_result");
    assert.equal(result[3].role, "assistant");
    assert.equal(block(result[3], 0, "text").text, "The file says hello world.");
  });

  it("user string content", () => {
    assert.equal(convert([{ role: "user", content: "hello" }])[0].content, "hello");
  });

  it("user empty string → [empty]", () => {
    assert.equal(convert([{ role: "user", content: "" }])[0].content, "[empty]");
  });

  it("user with array content containing text blocks", () => {
    const result = convert([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    assert.deepEqual(result[0].content, [{ type: "text", text: "hi" }]);
  });

  it("user with empty text blocks in array → [image] fallback", () => {
    assert.equal(
      convert([{ role: "user", content: [{ type: "text", text: "" }] }])[0].content,
      "[image]",
    );
  });

  it("tool name mapping: unserved pi names stay in the MCP namespace", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "a", name: "read", arguments: {} },
          { type: "toolCall", id: "b", name: "bash", arguments: {} },
        ],
      },
    ];
    const result = convert(msgs);
    assert.equal(block(result[0], 0, "tool_use").name, "mcp__custom-tools__read");
    assert.equal(block(result[0], 1, "tool_use").name, "mcp__custom-tools__bash");
  });

  it("an already-converted SDK tool name is refused", () => {
    assert.throws(() => mapPiToolNameToSdk("mcp__custom-tools__bash"), /already an SDK tool name/);
  });

  it("toolResult with array content extracts text", () => {
    const msgs = [
      {
        role: "toolResult",
        toolCallId: "x",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    ];
    assert.equal(block(convert(msgs)[0], 0, "tool_result").content, "line 1\nline 2");
  });

  it("toolResult carrying an image keeps the block-array shape", () => {
    const msgs = [
      {
        role: "toolResult",
        toolCallId: "shot",
        content: [
          { type: "text", text: "screenshot taken" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      },
    ];
    const content = block(convert(msgs)[0], 0, "tool_result").content;
    assert.ok(Array.isArray(content));
    assert.deepEqual(content[0], { type: "text", text: "screenshot taken" });
    assert.deepEqual(content[1], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    });
  });
});
