#!/usr/bin/env node
// A/B usage comparison: pi-doppelclaude vs Claude Code direct.
// Runs the same conversation through both paths and compares subscription usage
// delta and token metrics.
//
// One-off diagnostic — not part of the regular test suite.
// Requires: Claude Code OAuth credentials in the macOS keychain, `pi`, `claude`.
// Rate limit: the usage endpoint is aggressively limited — don't run repeatedly.
//
// Usage: node --import tsx tests/usage-test.ts [model] [turns]
//   model: claude-haiku-4-5 (default), claude-sonnet-4-6, claude-opus-4-6
//   turns: number of conversation turns (default: 10)

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isolateAgentDir } from "./lib/rpc-harness.js";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOGDIR = join(DIR, ".test-output");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const MODEL = process.argv[2] ?? "claude-haiku-4-5";

// The prompt corpus below has exactly MAX_TURNS entries; a turns argument beyond
// it, or a non-integer, is a caller mistake and fails fast rather than silently
// truncating or producing a fractional slice.
const MAX_TURNS = 10;
function parseTurns(raw: string | undefined): number {
  if (raw === undefined) return MAX_TURNS;
  const turns = Number(raw);
  if (!Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS) {
    throw new Error(`turns must be an integer in 1..${MAX_TURNS}, got ${JSON.stringify(raw)}`);
  }
  return turns;
}
const NUM_TURNS = parseTurns(process.argv[3]);

// Claude Code uses the same catalog IDs the bridge exposes for these models.
const CC_MODEL = MODEL;

interface Metrics {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost: number;
  turns: number;
}

interface UsageWindow {
  utilization: number;
}

interface UsageSnapshot {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus?: UsageWindow;
  seven_day_sonnet?: UsageWindow;
}

// pi --mode json emits one ndjson record per event; turn_end carries usage.
interface PiUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  cost?: { total?: number };
}

// claude --output-format json returns one object per invocation. Every field
// below feeds the A/B comparison, so all are required and conformed once.
interface ClaudeTurnResult {
  session_id: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens: number;
  };
}

const cleanPath = (process.env.PATH ?? "")
  .split(":")
  .filter((p) => !p.includes("node_modules"))
  .join(":");

// The async Pi run is spawned detached so it leads its own process group; we
// track that group id and SIGKILL the whole group (Pi and the Claude Code
// process Pi spawns) on interrupt/crash. The direct Claude turns use spawnSync,
// which reaps its child before returning, so only the Pi group needs tracking.
// This diagnostic is macOS/keychain-only, so negative-pid group signals apply.
const activeGroups = new Set<number>();

function killTrackedGroups(): void {
  for (const pgid of activeGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* group already exited */
    }
  }
  activeGroups.clear();
}

process.on("exit", killTrackedGroups);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    killTrackedGroups();
    process.exit(1);
  });
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected numeric ${label}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function setupEnv(): NodeJS.ProcessEnv {
  mkdirSync(LOGDIR, { recursive: true });
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const log = join(LOGDIR, `usage-test-direct-turn${turn}.json`);
    rmSync(log, { force: true });
    rmSync(`${log}.err`, { force: true });
  }
  const agentDir = isolateAgentDir("usage-test", LOGDIR, process.env.PI_CODING_AGENT_DIR);
  return {
    ...process.env,
    PATH: cleanPath,
    PI_CODING_AGENT_DIR: agentDir,
    DOPPELCLAUDE_DEBUG: "1",
    DOPPELCLAUDE_DEBUG_PATH: join(LOGDIR, "usage-test-debug.log"),
    CLAUDE_CODE_SAFE_MODE: "1",
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function oauthToken(): string {
  const raw = execFileSync(
    "security",
    ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
    {
      encoding: "utf8",
    },
  );
  const credentials = object(JSON.parse(raw), "Claude Code credentials");
  const oauth = object(credentials.claudeAiOauth, "Claude Code OAuth credentials");
  if (typeof oauth.accessToken !== "string" || !oauth.accessToken) {
    throw new Error("Could not extract OAuth token from keychain");
  }
  return oauth.accessToken;
}

function toWindow(value: unknown, label: string): UsageWindow {
  const utilization = object(value, label).utilization;
  return { utilization: requireNumber(utilization, `${label}.utilization`) };
}

function parseUsage(value: unknown): UsageSnapshot {
  const raw = object(value, "usage response");
  const snapshot: UsageSnapshot = {
    five_hour: toWindow(raw.five_hour, "five_hour"),
    seven_day: toWindow(raw.seven_day, "seven_day"),
  };
  if (raw.seven_day_opus != null)
    snapshot.seven_day_opus = toWindow(raw.seven_day_opus, "seven_day_opus");
  if (raw.seven_day_sonnet != null)
    snapshot.seven_day_sonnet = toWindow(raw.seven_day_sonnet, "seven_day_sonnet");
  return snapshot;
}

async function getUsage(token: string): Promise<UsageSnapshot> {
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
  });
  if (!res.ok) throw new Error(`usage fetch failed: ${res.status} ${res.statusText}`);
  return parseUsage(await res.json());
}

function printUsage(usage: UsageSnapshot): void {
  console.log(`  5h: ${usage.five_hour.utilization}%  7d: ${usage.seven_day.utilization}%`);
  if (usage.seven_day_opus) console.log(`  seven_day_opus: ${usage.seven_day_opus.utilization}%`);
  if (usage.seven_day_sonnet)
    console.log(`  seven_day_sonnet: ${usage.seven_day_sonnet.utilization}%`);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Same prompts for both paths. Mix of text-only and tool-use; tool prompts
// reference files in the project dir so both paths have equivalent work to do.
function buildPrompts(scratchFile: string): string[] {
  const prompts = [
    "Read package.json and explain what this project does based on its dependencies, scripts, and metadata. Be thorough.",
    `Write a detailed summary of what you just learned to ${scratchFile}`,
    "Read README.md and explain the architecture — how does the provider work, how are pi tools bridged to Claude Code?",
    "Read tsconfig.json and explain all the compiler options and why they might have been chosen.",
    "What are the tradeoffs of using the Agent SDK as a provider vs direct API access? Think through caching, latency, token overhead.",
    `Read ${scratchFile} back and compare it to what you now know. What did you miss in the first summary?`,
    "Read LICENSE and explain the implications of this license choice for an open source project.",
    "Summarize everything we've discussed. List every file you read, every file you wrote, and key takeaways.",
    "What would you change about this project's architecture if you were starting from scratch? Be specific.",
    "Give me a final one-paragraph summary of our entire conversation.",
  ];
  return prompts.slice(0, NUM_TURNS);
}

function printMetricsTable(rows: PiUsage[]): Metrics {
  console.log(
    `${"Turn".padEnd(6)}  ${"Input".padStart(8)}  ${"CacheRd".padStart(8)}  ${"CacheWr".padStart(8)}  ${"Output".padStart(8)}  ${"Cost".padStart(10)}`,
  );
  console.log("------  --------  --------  --------  --------  ----------");

  const total: Metrics = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, turns: 0 };
  for (const usage of rows) {
    const cost = usage.cost?.total ?? 0;
    total.turns += 1;
    total.input += usage.input;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.output += usage.output;
    total.cost = round(total.cost + cost, 6);
    console.log(
      `${String(total.turns).padEnd(6)}  ${String(usage.input).padStart(8)}  ${String(usage.cacheRead).padStart(8)}  ${String(usage.cacheWrite).padStart(8)}  ${String(usage.output).padStart(8)}  $${cost}`,
    );
  }

  console.log("------  --------  --------  --------  --------  ----------");
  console.log(
    `${"Total".padEnd(6)}  ${String(total.input).padStart(8)}  ${String(total.cacheRead).padStart(8)}  ${String(total.cacheWrite).padStart(8)}  ${String(total.output).padStart(8)}  $${total.cost}`,
  );

  const cacheTotal = total.input + total.cacheRead + total.cacheWrite;
  if (cacheTotal > 0)
    console.log(`Cache hit rate: ${round((total.cacheRead * 100) / cacheTotal, 1)}%`);
  return total;
}

function parseCost(value: unknown): { total: number } | undefined {
  if (value === undefined) return undefined;
  const total = object(value, "turn_end usage.cost").total;
  return { total: requireNumber(total, "turn_end usage.cost.total") };
}

function parseTurnEndUsage(value: unknown): PiUsage | null {
  const record = object(value, "Pi event");
  if (record.type !== "turn_end") return null;
  const message = object(record.message, "turn_end message");
  const u = object(message.usage, "turn_end usage");
  return {
    input: requireNumber(u.input, "turn_end usage.input"),
    cacheRead: requireNumber(u.cacheRead, "turn_end usage.cacheRead"),
    cacheWrite: requireNumber(u.cacheWrite, "turn_end usage.cacheWrite"),
    output: requireNumber(u.output, "turn_end usage.output"),
    cost: parseCost(u.cost),
  };
}

function parsePiTurns(logFile: string): PiUsage[] {
  const turns: PiUsage[] = [];
  for (const [index, line] of readFileSync(logFile, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`invalid Pi JSON on line ${index + 1} of ${logFile}`);
    }
    const usage = parseTurnEndUsage(record);
    if (usage) turns.push(usage);
  }
  if (turns.length === 0) throw new Error(`Pi emitted no turn_end usage records (see ${logFile})`);
  return turns;
}

async function runPi(env: NodeJS.ProcessEnv, prompts: string[], logFile: string): Promise<void> {
  const promptArgs = prompts.flatMap((p) => ["-p", p]);
  const args = [
    "--no-session",
    "-ne",
    "-e",
    DIR,
    "--model",
    `anthropic/${MODEL}`,
    "--mode",
    "json",
    ...promptArgs,
  ];

  const out = createWriteStream(logFile);
  const err = createWriteStream(`${logFile}.err`);

  // detached: pi leads its own process group so a hung or failed run's whole
  // group (including the Claude Code process pi spawns) can be SIGKILLed. stdin
  // is ignored so print mode exits on EOF instead of waiting; the timeout kills a
  // hung run, surfacing as a signal below.
  const child = spawn("pi", args, {
    cwd: DIR,
    env,
    timeout: 600_000,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid) activeGroups.add(child.pid);

  try {
    // pipeline awaits both the child stream ending and the log flush to disk and
    // propagates any write error; once("close") yields the exit. Awaiting all
    // three together guarantees both logs are complete before we inspect the exit.
    const [, , [code, signal]] = await Promise.all([
      pipeline(child.stdout, out),
      pipeline(child.stderr, err),
      once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
    ]);
    if (signal) throw new Error(`pi terminated by signal ${signal} (see ${logFile}.err)`);
    if (code !== 0) throw new Error(`pi exited with code ${code} (see ${logFile}.err)`);
  } catch (error) {
    // A timeout SIGTERMs only pi; SIGKILL the whole group so no Claude child leaks.
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* group already exited */
      }
    }
    throw error;
  } finally {
    if (child.pid) activeGroups.delete(child.pid);
  }
}

// Conform one direct turn's JSON. A failed or malformed turn throws with its log
// path: unlike the old shell diagnostic's `|| true`, a silent zero-usage row is
// never emitted, because it would corrupt the A/B comparison this exists to make.
function parseClaudeTurn(raw: string, jsonLog: string): ClaudeTurnResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`claude turn produced non-JSON output (see ${jsonLog})`);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`claude turn JSON was not an object (see ${jsonLog})`);
  const record = parsed as { session_id?: unknown; total_cost_usd?: unknown; usage?: unknown };
  if (typeof record.session_id !== "string" || !record.session_id)
    throw new Error(`claude turn JSON missing session_id (see ${jsonLog})`);
  if (typeof record.usage !== "object" || record.usage === null)
    throw new Error(`claude turn JSON missing usage (see ${jsonLog})`);
  const u = record.usage as Record<string, unknown>;
  return {
    session_id: record.session_id,
    total_cost_usd: requireNumber(record.total_cost_usd, `turn total_cost_usd (${jsonLog})`),
    usage: {
      input_tokens: requireNumber(u.input_tokens, `turn usage.input_tokens (${jsonLog})`),
      cache_read_input_tokens: requireNumber(
        u.cache_read_input_tokens,
        `turn usage.cache_read_input_tokens (${jsonLog})`,
      ),
      cache_creation_input_tokens: requireNumber(
        u.cache_creation_input_tokens,
        `turn usage.cache_creation_input_tokens (${jsonLog})`,
      ),
      output_tokens: requireNumber(u.output_tokens, `turn usage.output_tokens (${jsonLog})`),
    },
  };
}

// Each direct turn is its own `claude -p` invocation; --resume threads the
// session. spawnSync reaps the child before returning. Per-turn stdout/stderr are
// preserved as evidence, and any failure (nonzero, signal, spawn error, or
// unparseable JSON) fails the diagnostic with the log path.
function runClaudeTurn(
  env: NodeJS.ProcessEnv,
  prompt: string,
  resumeId: string | null,
  turnIndex: number,
): ClaudeTurnResult {
  const jsonLog = join(LOGDIR, `usage-test-direct-turn${turnIndex}.json`);
  const errLog = `${jsonLog}.err`;
  const args = [
    "--model",
    CC_MODEL,
    "--output-format",
    "json",
    "-p",
    prompt,
    "--permission-mode",
    "bypassPermissions",
  ];
  if (resumeId) args.push("--resume", resumeId);

  const result = spawnSync("claude", args, {
    cwd: DIR,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(jsonLog, result.stdout ?? "");
  writeFileSync(errLog, result.stderr ?? "");

  if (result.error)
    throw new Error(`claude turn ${turnIndex} failed: ${result.error.message} (see ${errLog})`);
  if (result.signal)
    throw new Error(
      `claude turn ${turnIndex} terminated by signal ${result.signal} (see ${errLog})`,
    );
  if (result.status !== 0)
    throw new Error(`claude turn ${turnIndex} exited with code ${result.status} (see ${errLog})`);
  return parseClaudeTurn(result.stdout, jsonLog);
}

async function runBridge(
  env: NodeJS.ProcessEnv,
  token: string,
): Promise<{ metrics: Metrics; delta: number }> {
  console.log("==========================================");
  console.log("  Run A: pi-doppelclaude");
  console.log("==========================================");

  console.log("Fetching usage before...");
  const before = await getUsage(token);
  printUsage(before);

  const scratch = join(LOGDIR, "usage-test-scratch-a.txt");
  rmSync(scratch, { force: true });
  const logFile = join(LOGDIR, "usage-test-bridge.ndjson");
  console.log("\nRunning bridge conversation...");
  try {
    await runPi(env, buildPrompts(scratch), logFile);
  } finally {
    rmSync(scratch, { force: true });
  }

  console.log("");
  const metrics = printMetricsTable(parsePiTurns(logFile));

  console.log("\nWaiting 15s for usage to settle...");
  await sleep(15_000);

  console.log("Fetching usage after...");
  const after = await getUsage(token);
  printUsage(after);
  const delta = round(after.five_hour.utilization - before.five_hour.utilization, 2);
  console.log(`  5h delta: +${delta}%`);
  return { metrics, delta };
}

async function runDirect(
  env: NodeJS.ProcessEnv,
  token: string,
): Promise<{ metrics: Metrics; delta: number }> {
  console.log("\n==========================================");
  console.log("  Run B: Claude Code direct");
  console.log("==========================================");

  console.log("Fetching usage before...");
  const before = await getUsage(token);
  printUsage(before);

  const scratch = join(LOGDIR, "usage-test-scratch-b.txt");
  rmSync(scratch, { force: true });
  console.log("\nRunning Claude Code direct conversation...");

  // Each turn is a separate `claude -p` invocation with --resume to keep the session.
  const rows: PiUsage[] = [];
  let resumeId: string | null = null;
  let turnIndex = 0;
  try {
    for (const prompt of buildPrompts(scratch)) {
      turnIndex += 1;
      const result = runClaudeTurn(env, prompt, resumeId, turnIndex);
      resumeId = result.session_id;
      rows.push({
        input: result.usage.input_tokens,
        cacheRead: result.usage.cache_read_input_tokens,
        cacheWrite: result.usage.cache_creation_input_tokens,
        output: result.usage.output_tokens,
        cost: { total: result.total_cost_usd },
      });
    }
  } finally {
    rmSync(scratch, { force: true });
  }

  console.log("");
  const metrics = printMetricsTable(rows);

  console.log("\nWaiting 15s for usage to settle...");
  await sleep(15_000);

  console.log("Fetching usage after...");
  const after = await getUsage(token);
  printUsage(after);
  const delta = round(after.five_hour.utilization - before.five_hour.utilization, 2);
  console.log(`  5h delta: +${delta}%`);
  return { metrics, delta };
}

function cacheHitRate(m: Metrics): number {
  const total = m.input + m.cacheRead + m.cacheWrite;
  return total > 0 ? round((m.cacheRead * 100) / total, 1) : 0;
}

function printComparison(
  a: { metrics: Metrics; delta: number },
  b: { metrics: Metrics; delta: number },
): void {
  console.log("\n==========================================");
  console.log("  Comparison");
  console.log("==========================================");

  const col = (value: string) => value.padStart(12);
  const row = (label: string, av: string, bv: string, diff: string) =>
    `  ${label.padEnd(17)}${col(av)}  ${col(bv)}  ${col(diff)}`;
  const signed = (value: number) => (value >= 0 ? `+${value}` : `${value}`);

  console.log(row("", "Bridge", "Direct", "Diff"));
  console.log(row("", "------", "------", "----"));
  console.log(
    row(
      "Input tokens",
      `${a.metrics.input}`,
      `${b.metrics.input}`,
      signed(a.metrics.input - b.metrics.input),
    ),
  );
  console.log(
    row(
      "Cache read tokens",
      `${a.metrics.cacheRead}`,
      `${b.metrics.cacheRead}`,
      signed(a.metrics.cacheRead - b.metrics.cacheRead),
    ),
  );
  console.log(
    row(
      "Cache write tokens",
      `${a.metrics.cacheWrite}`,
      `${b.metrics.cacheWrite}`,
      signed(a.metrics.cacheWrite - b.metrics.cacheWrite),
    ),
  );
  console.log(
    row(
      "Output tokens",
      `${a.metrics.output}`,
      `${b.metrics.output}`,
      signed(a.metrics.output - b.metrics.output),
    ),
  );
  console.log(
    row(
      "API-equiv cost",
      `$${a.metrics.cost}`,
      `$${b.metrics.cost}`,
      `$${round(a.metrics.cost - b.metrics.cost, 6)}`,
    ),
  );
  console.log(
    row(
      "Cache hit rate",
      `${cacheHitRate(a.metrics)}%`,
      `${cacheHitRate(b.metrics)}%`,
      `${round(cacheHitRate(a.metrics) - cacheHitRate(b.metrics), 1)}%`,
    ),
  );
  console.log(
    row("Usage delta (5h)", `${a.delta}%`, `${b.delta}%`, `${round(a.delta - b.delta, 2)}%`),
  );

  if (a.delta === b.delta) {
    console.log("\n  Result: Same usage impact.");
  } else if (a.delta > b.delta) {
    console.log(`\n  Result: Bridge used ${round(a.delta - b.delta, 2)}% more of 5h window.`);
  } else {
    console.log(`\n  Result: Bridge used ${round(b.delta - a.delta, 2)}% less of 5h window.`);
  }
}

async function main(): Promise<void> {
  console.log("=== usage-test.ts ===");
  console.log(`Model: ${MODEL}`);
  console.log(`Turns: ${NUM_TURNS}\n`);

  const env = setupEnv();
  const token = oauthToken();

  const bridge = await runBridge(env, token);
  const direct = await runDirect(env, token);
  printComparison(bridge, direct);

  console.log("\nLogs:");
  console.log(`  Bridge: ${join(LOGDIR, "usage-test-bridge.ndjson")}`);
  console.log(`  Direct: ${join(LOGDIR, "usage-test-direct-turn*.json")} (+ .err per turn)`);
}

await main();
