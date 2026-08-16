// Mechanical probe of the Anthropic API's prompt serialization order.
//
//   node --import tsx diag/relocation-spike/order-probe.ts
//
// Nobody client-side can dump the assembled model prompt: the splice of tools[]
// into prompt text happens server-side. But the prompt cache testifies about it.
// The cache matches strict prefixes up to explicit breakpoints, so:
//
//   run 1: tools T (cache breakpoint injected on the last tool), system S1 -> writes
//   run 2: tools T (same breakpoint),                            system S2 -> ?
//
// If serialization is tools-then-system, run 2's prefix still matches through the
// tool breakpoint and cache_read comes back ~= the tool block's tokens. If it is
// system-then-tools, the prefix diverges before the breakpoint and cache_read is 0.
//
// A forwarding proxy injects cache_control into CC's live request so the traffic
// is otherwise exactly what Claude Code sends (auth included, never logged).
// Cost: two small haiku requests.

import { createServer } from "node:http";
import { type McpServerConfig, query } from "@anthropic-ai/claude-agent-sdk";
import { Server as McpLowLevelServer } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const UPSTREAM = "https://api.anthropic.com";
const MODEL = "claude-haiku-4-5-20251001";

// Fat, stable description so the tool block is unmistakably many tokens.
// Haiku's minimum cacheable prefix is 2048 tokens; the tool block alone must clear
// it. One fat tool cannot get there — CC caps each description at 2048 CHARS (the
// very defect this spike exists for) — so use many capped-size tools instead.
const TOOL_DESCRIPTION = `Order probe fixture tool. ${"The quick brown fox jumps over the lazy dog. ".repeat(43)}`;
const TOOL_COUNT = 10;

function mcpServers(): Record<string, McpServerConfig> {
  const server = new McpLowLevelServer(
    { name: "custom-tools", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Array.from({ length: TOOL_COUNT }, (_, i) => ({
      name: `order_probe_${i}`,
      description: `Fixture ${i}. ${TOOL_DESCRIPTION}`,
      inputSchema: { type: "object", properties: {} },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, () => ({
    content: [{ type: "text", text: "unused" }],
  }));
  return { "custom-tools": { type: "sdk", name: "custom-tools", instance: server as never } };
}

interface Observed {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

function usageFromSse(text: string): Observed | null {
  const start = text.match(/^data: (\{"type":"message_start".*)$/m);
  if (!start) return null;
  const usage = JSON.parse(start[1]).message?.usage ?? {};
  return {
    input: usage.input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

const observations: { label: string; usage: Observed }[] = [];
let currentLabel = "";

const proxy = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = Buffer.concat(chunks);
    let isProbeRequest = false;
    if (req.url?.includes("/v1/messages") && !req.url.includes("count_tokens")) {
      try {
        const parsed = JSON.parse(body.toString("utf8"));
        const tools = parsed.tools;
        if (Array.isArray(tools) && tools.some((t) => t.name?.includes("order_probe"))) {
          isProbeRequest = true;
          // CC's system blocks ask for ttl 1h; a 5m block before them is rejected
          // (the rejection message itself names the processing order).
          tools[tools.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
          body = Buffer.from(JSON.stringify(parsed));
        }
      } catch {}
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string" && !["host", "content-length", "connection"].includes(k))
        headers.set(k, v);
    }
    headers.set("content-length", String(body.length));
    const upstream = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "POST" ? body : undefined,
    });
    const text = await upstream.text();
    console.error(
      `[proxy] ${req.method} ${req.url} -> ${upstream.status} probe=${isProbeRequest} bytes=${text.length}`,
    );
    if (isProbeRequest) {
      const usage = usageFromSse(text);
      if (usage) observations.push({ label: currentLabel, usage });
      else console.error(`[proxy] no usage parsed; head: ${text.slice(0, 300)}`);
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
    });
    res.end(text);
  });
});

await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
const address = proxy.address();
if (address === null || typeof address === "string") throw new Error("no port");
const port = address.port;

async function run(label: string, systemPrompt: string): Promise<void> {
  currentLabel = label;
  const q = query({
    prompt: "Reply with exactly: ok",
    options: {
      env: { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
      tools: [],
      strictMcpConfig: true,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt,
      settingSources: [],
      model: MODEL,
      maxTurns: 1,
      persistSession: false,
      mcpServers: mcpServers(),
    },
  });
  for await (const message of q) {
    if (message.type === "result") {
      console.error(`[query ${label}] result subtype=${(message as { subtype?: string }).subtype}`);
      break;
    }
  }
  try {
    q.close();
  } catch {}
}

await run("write (system S1)", "You are probe assistant one. Answer tersely.");
await run(
  "probe (system S2, same tools)",
  "You are a completely different probe assistant, number two, with an intentionally changed system prompt of different length and content.",
);
proxy.close();

console.log("");
for (const { label, usage } of observations) {
  console.log(
    `${label.padEnd(30)} input=${usage.input} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`,
  );
}
const probe = observations.find((o) => o.label.startsWith("probe"));
if (!probe) throw new Error("probe request was not observed");
console.log("");
console.log(
  probe.usage.cacheRead > 0
    ? `VERDICT: cache_read=${probe.usage.cacheRead} with system changed -> the cached prefix through the last tool survived -> tools are serialized BEFORE system.`
    : "VERDICT: cache_read=0 with system changed -> no prefix survived -> tools are NOT serialized before system (or tool breakpoints unsupported here).",
);
