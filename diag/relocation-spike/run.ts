// Spike for docs/designs/04-tool-description-relocation.md: capture the exact
// /v1/messages request Claude Code sends for each candidate mechanism, so the
// relocate/splice/duplicate options can be judged on rendered bytes instead of
// speculation.
//
//   node --import tsx diag/relocation-spike/run.ts
//
// A local stub stands in for api.anthropic.com (ANTHROPIC_BASE_URL): it records
// the request body and answers with a minimal SSE turn, so no quota is spent and
// nothing leaves the machine. Auth headers are received and discarded.
//
// Outputs, per variant, in this directory:
//   request-<variant>.json    the tools[] + system[] CC actually sent
//   rendered-<variant>.txt    line-numbered render of system prompt + tool descriptions
// plus FINDINGS.md with the line-level annotations.

import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type McpServerConfig, query } from "@anthropic-ai/claude-agent-sdk";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const CAP = 2048;
const MODEL = "claude-haiku-4-5-20251001";

const fullDescription = readFileSync(join(DIR, "mcp-description.txt"), "utf8");
if (fullDescription.length <= CAP)
  throw new Error(`fixture description is ${fullDescription.length} chars; spike needs > ${CAP}`);

// A compact but structurally faithful pi-mode system prompt: identity, tool-name
// note, the "Available tools:" anchor block, then trailing guidelines.
const BASE_PROMPT = `You are 2B of NieR: Automata, a coding assistant running in pi, a coding agent harness. Emotions are prohibited. Help the user inspect files, run commands, edit code, and create files when needed.

Tool name note: You see tool names that require a prefix when called, but instructions refer to tools by their bare names. For example, \`mcp__custom-tools__bash\` is referred to as the \`bash\` tool.

Available tools:
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- mcp: MCP gateway for configured MCP servers

Guidelines:
- Use bash for file operations like ls, rg, find
- Be concise in your responses
- Show file paths clearly when working with files`;

const ANCHOR = "\n\nGuidelines:";

function withSection(section: string): string {
  // Splice adjacent to the Available tools block (directly after it).
  return BASE_PROMPT.replace(ANCHOR, `\n\n${section}${ANCHOR}`);
}

const STUB = `Full description in the system prompt under "Full description: mcp".`;
const SECTION_PREAMBLE = `Some tool descriptions exceed this environment's inline limit; their full text follows.`;

const variants: Record<string, { toolDescription: string; systemPrompt: string }> = {
  baseline: {
    toolDescription: fullDescription,
    systemPrompt: BASE_PROMPT,
  },
  relocate: {
    toolDescription: STUB,
    systemPrompt: withSection(
      `${SECTION_PREAMBLE}\n\n## Full description: mcp\n${fullDescription}`,
    ),
  },
  "relocate-v2": {
    toolDescription: STUB,
    // Prepend, so the block sits directly under the harness's </functions> render,
    // separated only by system[1]'s single line — and speak the harness's own
    // <function>{json}</function> vocabulary instead of inventing a heading.
    systemPrompt: `Full definitions for tools above whose description was elided for length:
<function>${JSON.stringify({ description: fullDescription, name: "mcp__custom-tools__mcp", parameters: { type: "object", properties: {} } })}</function>

${BASE_PROMPT}`,
  },
  splice: {
    toolDescription: fullDescription,
    systemPrompt: withSection(
      `Continuations of tool descriptions truncated at the inline limit; each continues exactly where the tool description ends.\n\n## Continuation: mcp\n\u2026${fullDescription.slice(CAP)}`,
    ),
  },
  duplicate: {
    toolDescription: fullDescription,
    systemPrompt: withSection(
      `${SECTION_PREAMBLE}\n\n## Full description: mcp\n${fullDescription}`,
    ),
  },
};

// --- capture stub -----------------------------------------------------------

interface Captured {
  system: unknown;
  tools: unknown;
}

function sseTurn(): string {
  const events: Array<[string, object]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_spike",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function startCaptureServer(
  onMessages: (body: Captured) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url?.includes("/v1/messages") && !req.url.includes("count_tokens")) {
          try {
            const parsed = JSON.parse(body);
            // CC sends toolless side requests too; only the one carrying our MCP tool matters.
            if (JSON.stringify(parsed.tools ?? []).includes("custom-tools")) {
              onMessages({ system: parsed.system, tools: parsed.tools });
            }
          } catch {}
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sseTurn());
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

// --- bridged MCP tool (mirrors bridge-runtime's low-level server shape) -----

function mcpServers(toolDescription: string): Record<string, McpServerConfig> {
  const server = new McpLowLevelServer(
    { name: "custom-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "mcp",
        description: toolDescription,
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: "text", text: "unused" }],
  }));
  return { "custom-tools": { type: "sdk", name: "custom-tools", instance: server as never } };
}

// --- render + annotate ------------------------------------------------------

function blocksToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system))
    return system
      .map(
        (b: { text?: string }, i: number) =>
          `\u2500\u2500 system[${i}] \u2500\u2500\n${b.text ?? JSON.stringify(b)}`,
      )
      .join("\n\n");
  return JSON.stringify(system, null, 2);
}

function toolsToText(tools: unknown): string {
  if (!Array.isArray(tools)) return JSON.stringify(tools, null, 2);
  return tools
    .map(
      (t: { name?: string; description?: string }) =>
        `\u2500\u2500 tool: ${t.name} (description ${t.description?.length ?? 0} chars) \u2500\u2500\n${t.description ?? ""}`,
    )
    .join("\n\n");
}

function numbered(text: string): { rendered: string; lineOf: (needle: string) => number } {
  const lines = text.split("\n");
  const rendered = lines.map((l, i) => `${String(i + 1).padStart(4)} \u2502 ${l}`).join("\n");
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle)) + 1;
  return { rendered, lineOf };
}

// --- main -------------------------------------------------------------------

const findings: string[] = [
  "# Relocation spike: CC's rendered prompt per mechanism",
  "",
  `Captured from a real Claude Code subprocess (Agent SDK) against a local stub API.`,
  `Fixture: the live 3,111-char \`mcp\` proxy description; CC cap ${CAP}.`,
  "",
];

for (const [name, variant] of Object.entries(variants)) {
  let captured: Captured | undefined;
  const { server, port } = await startCaptureServer((c) => {
    captured ??= c;
  });

  const q = query({
    prompt: "hi",
    options: {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        DISABLE_AUTO_COMPACT: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      tools: [],
      strictMcpConfig: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: variant.systemPrompt,
      settingSources: [],
      model: MODEL,
      maxTurns: 1,
      persistSession: false,
      mcpServers: mcpServers(variant.toolDescription),
    },
  });

  try {
    for await (const _message of q) {
      if (captured) break;
    }
  } catch (error) {
    if (!captured) throw error;
  } finally {
    try {
      q.close();
    } catch {}
    server.close();
  }

  if (!captured) throw new Error(`${name}: no /v1/messages request with the bridged tool captured`);
  writeFileSync(join(DIR, `request-${name}.json`), `${JSON.stringify(captured, null, 2)}\n`);

  // Model-order render: the Anthropic backend expands tools[] into a <functions>
  // block ABOVE the system blocks; mirror that so the file teaches true adjacency.
  const full = `${"\u2550".repeat(20)} TOOLS (rendered by the API as <functions>, first) ${"\u2550".repeat(20)}\n${toolsToText(captured.tools)}\n\n${"\u2550".repeat(20)} SYSTEM (follows the tools block) ${"\u2550".repeat(20)}\n${blocksToText(captured.system)}`;
  const { rendered, lineOf } = numbered(full);
  writeFileSync(join(DIR, `rendered-${name}.txt`), rendered);

  const toolLine = lineOf("tool: mcp");
  const truncLine = lineOf("[truncated]");
  const sectionLine = lineOf(
    name === "splice"
      ? "## Continuation: mcp"
      : name === "relocate-v2"
        ? "Full definitions for tools above"
        : "## Full description: mcp",
  );
  const stubLine = lineOf(STUB);
  const usageInTool = toolsToText(captured.tools).includes("\nUsage:");
  const usageInSystem = blocksToText(captured.system).includes("\nUsage:");
  const usageLine = lineOf("Usage:");
  const lastBulletLine = lineOf("free-text input over a selector");

  findings.push(
    `## ${name}`,
    "",
    `- tool \`mcp\` entry at line ${toolLine} (\`rendered-${name}.txt\`)`,
    truncLine > 0
      ? `- CC's cap fired: \`[truncated]\` at line ${truncLine}`
      : `- CC's cap did not fire`,
    sectionLine > 0
      ? `- system prompt section at line ${sectionLine}`
      : `- no system prompt section`,
    stubLine > 0 ? `- pointer stub at line ${stubLine}` : "",
    usageInTool || usageInSystem
      ? `- usage table survives at line ${usageLine} (${usageInTool ? "tool description" : "system prompt"})`
      : `- usage table LOST to the cap`,
    lastBulletLine > 0
      ? `- final instruction bullet survives at line ${lastBulletLine}`
      : `- final instruction bullet LOST`,
    "",
  );
  console.log(`${name}: captured (system ${blocksToText(captured.system).length} chars)`);
}

writeFileSync(join(DIR, "FINDINGS.md"), findings.filter((l) => l !== undefined).join("\n"));
console.log("done \u2192 diag/relocation-spike/");
