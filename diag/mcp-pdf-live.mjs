#!/usr/bin/env node

// Run with `node diag/mcp-pdf-live.mjs`. Costs three short Haiku queries.
// Compare MCP embedded-resource delivery with a native SDK document prompt.
// Add --resume-at-call to test an explicit resume anchor (rejected by CC 2.1.280).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { createSession } from "cc-session-io";
import { sdkChildEnv } from "doppelclaude/sdk-child-env";
import { BridgeSessionStore } from "doppelclaude/session-store";

const code = randomBytes(8).toString("hex");
const stream = `BT /F1 24 Tf 72 700 Td (Verification code: ${code}) Tj ET\n1 0 0 rg 100 100 m 300 100 l 200 300 l h f\n`;
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let pdf = "%PDF-1.4\n";
const offsets = [];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const data = Buffer.from(pdf).toString("base64");
const cwd = await mkdtemp(join(tmpdir(), "mcp-pdf-probe-"));
const question =
  "Give the verification code printed in the PDF and the color and shape drawn below it. Do not guess if you cannot see them.";
let calls = 0;

async function run(label, content, mcpServers, resumeOptions = {}) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 90_000);
  const toolResults = [];
  let answer;
  const sdkQuery = query({
    prompt: (async function* () {
      yield {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      };
    })(),
    options: {
      cwd,
      model: "claude-haiku-4-5",
      tools: [],
      mcpServers,
      allowedTools: ["mcp__pdfsrv__get_pdf"],
      settingSources: [],
      env: sdkChildEnv(),
      maxTurns: 3,
      abortController,
      ...resumeOptions,
    },
  });
  try {
    for await (const message of sdkQuery) {
      if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === "tool_result") toolResults.push(block);
        }
      }
      if (message.type === "result") {
        assert.equal(message.subtype, "success", JSON.stringify(message));
        answer = message.result;
      }
    }
    assert.equal(typeof answer, "string");
    const sawCode = answer.includes(code);
    const sawShape = /red/i.test(answer) && /triangle/i.test(answer);
    console.log(
      JSON.stringify({ label, toolResults, answer, sawCode, sawShape }, (key, value) =>
        key === "data" || key === "blob" ? `<${value.length} encoded characters>` : value,
      ),
    );
    return { toolResults, sawCode, sawShape };
  } finally {
    clearTimeout(timeout);
    sdkQuery.close();
  }
}

try {
  const server = createSdkMcpServer({
    name: "pdfsrv",
    version: "1",
    tools: [
      tool("get_pdf", "Return the PDF report.", {}, async () => {
        calls++;
        return {
          content: [
            {
              type: "resource",
              resource: { uri: "file:///report.pdf", mimeType: "application/pdf", blob: data },
            },
          ],
        };
      }),
    ],
  });
  const resource = await run("MCP embedded PDF", `Call get_pdf once, then: ${question}`, {
    pdfsrv: server,
  });
  assert.equal(calls, 1);
  assert.ok(resource.toolResults.length > 0, "the MCP result must reach Claude Code");
  const native = await run(
    "Native PDF control",
    [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
      { type: "text", text: question },
    ],
    {},
  );
  assert.ok(native.sawCode && native.sawShape, "positive control must see text and graphics");
  console.log(
    resource.sawCode && resource.sawShape
      ? "MCP PDF content reached the model; inspect toolResults for native document conversion."
      : "MCP PDF content did not reach the model; native PDF control passed.",
  );
  const session = createSession({ projectPath: cwd, model: "claude-haiku-4-5" });
  session.addUserMessage(`Call get_pdf once, then: ${question}`);
  const pendingCall = session.addAssistantMessage(
    [{ type: "tool_use", id: "pdf_call", name: "mcp__pdfsrv__get_pdf", input: {} }],
    { stopReason: "tool_use" },
  );
  const store = new BridgeSessionStore();
  store.replace(session.sessionId, session.records);
  const writer = store.createWriter("native-result-probe");
  try {
    const resumed = await run(
      "Resume with native PDF tool result",
      [
        {
          type: "tool_result",
          tool_use_id: "pdf_call",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
          ],
        },
      ],
      {},
      {
        resume: session.sessionId,
        sessionStore: writer,
        ...(process.argv.includes("--resume-at-call") ? { resumeSessionAt: pendingCall } : {}),
      },
    );
    const transcript = store.load(session.sessionId);
    assert.ok(
      transcript.some((entry) => entry.message && JSON.stringify(entry.message).includes(data)),
      "the submitted PDF result must reach the SDK transcript",
    );
    console.log(
      JSON.stringify({
        transcript: transcript.map((entry) => ({
          uuid: entry.uuid,
          parentUuid: entry.parentUuid,
          type: entry.type,
          content: Array.isArray(entry.message?.content)
            ? entry.message.content.map((block) => ({
                type: block.type,
                id: block.id,
                tool_use_id: block.tool_use_id,
                text: block.text,
              }))
            : entry.message?.content,
        })),
      }),
    );
    console.log(
      resumed.sawCode && resumed.sawShape
        ? "Native PDF tool-result input after resume: SUPPORTED; inspect transcript pairing."
        : "Native PDF tool-result input after resume: NOT SUPPORTED; the model did not see the PDF.",
    );
  } finally {
    writer.close();
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}
