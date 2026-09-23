// Pi carries the system prompt and tool declarations inside the transcript. Claude Code takes
// both as spawn options, so readPiTranscript has to replay every mid-conversation update into
// its current state -- reading only the leading system message would silently serve a stale
// prompt and a stale tool set.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSystemMessageText, normalizeContext, type Tool } from "@earendil-works/pi-ai";
import { readPiTranscript } from "pi-doppelclaude/convert";
import { Type } from "typebox";

function tool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: Type.Object({ path: Type.String() }),
  };
}

function user(content: string, timestamp: number) {
  return { role: "user" as const, content, timestamp };
}

describe("readPiTranscript", () => {
  it("resolves the tool set a mid-conversation update left behind", () => {
    const transcript = readPiTranscript(
      normalizeContext({
        systemPrompt: "Base prompt.",
        tools: [tool("alpha"), tool("beta")],
        messages: [
          user("first", 1),
          {
            role: "system",
            content: "Later instructions.",
            toolsAdded: [tool("gamma")],
            toolsRemoved: [{ name: "alpha" }],
            timestamp: 2,
          },
          user("second", 3),
        ],
      }),
    );

    assert.deepEqual(
      transcript.tools.map((declared) => declared.name),
      ["beta", "gamma"],
    );
  });

  it("appends later instructions to the leading prompt", () => {
    const transcript = readPiTranscript(
      normalizeContext({
        systemPrompt: "Base prompt.",
        tools: [],
        messages: [
          user("first", 1),
          { role: "system", content: "Later instructions.", timestamp: 2 },
          user("second", 3),
        ],
      }),
    );

    assert.ok(transcript.systemMessage);
    const prompt = getSystemMessageText(transcript.systemMessage);
    assert.match(prompt, /Base prompt\./);
    assert.match(prompt, /Later instructions\./);
  });

  it("leaves no system message for the message conversion to drop", () => {
    const transcript = readPiTranscript(
      normalizeContext({
        systemPrompt: "Base prompt.",
        tools: [tool("alpha")],
        messages: [
          user("first", 1),
          { role: "system", content: "Later instructions.", timestamp: 2 },
          user("second", 3),
        ],
      }),
    );

    assert.deepEqual(
      transcript.messages.map((message) => message.role),
      ["user", "user"],
    );
  });

  it("keeps an empty context empty", () => {
    const transcript = readPiTranscript(
      normalizeContext({ systemPrompt: "", tools: [], messages: [user("first", 1)] }),
    );

    assert.equal(transcript.systemMessage, undefined);
    assert.deepEqual(transcript.tools, []);
    assert.deepEqual(
      transcript.messages.map((message) => message.role),
      ["user"],
    );
  });
});
