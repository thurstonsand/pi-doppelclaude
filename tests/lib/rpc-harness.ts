/**
 * Shared RPC harness for pi integration tests.
 * Provides spawn, send, event waiting, and text collection utilities.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  type WriteStream,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";

// Isolate Pi's agent dir so developer settings cannot alter test behavior. Pi
// provider credentials are copied into the sandbox so alt-provider auth still
// works; Claude Code's own auth (~/.claude / $CLAUDE_CONFIG_DIR) is unaffected.
export interface RpcMessage {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  reason?: string;
  data?: unknown;
  toolName?: string;
  result?: unknown;
  aborted?: boolean;
  assistantMessageEvent?: AssistantMessageEvent;
}

export interface CompactionDetails {
  readFiles?: unknown[];
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  usage?: Usage;
  details?: CompactionDetails;
}

export interface CompactionEndEvent extends RpcMessage {
  aborted: boolean;
  result: CompactionResult;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function parseAssistantMessageEvent(value: unknown): AssistantMessageEvent | undefined {
  if (value === undefined) return undefined;
  const event = record(value, "assistantMessageEvent");
  if (typeof event.type !== "string")
    throw new Error("assistantMessageEvent.type must be a string");
  if (event.type === "text_delta" && typeof event.delta !== "string") {
    throw new Error("text_delta assistantMessageEvent.delta must be a string");
  }
  return event as unknown as AssistantMessageEvent;
}

export function parseRpcMessage(value: unknown): RpcMessage {
  const message = record(value, "RPC message");
  if (typeof message.type !== "string") throw new Error("RPC message.type must be a string");
  return {
    type: message.type,
    id: optionalString(message.id, "RPC message.id"),
    success: optionalBoolean(message.success, "RPC message.success"),
    error: optionalString(message.error, "RPC message.error"),
    reason: optionalString(message.reason, "RPC message.reason"),
    toolName: optionalString(message.toolName, "RPC message.toolName"),
    aborted: optionalBoolean(message.aborted, "RPC message.aborted"),
    data: message.data,
    result: message.result,
    assistantMessageEvent: parseAssistantMessageEvent(message.assistantMessageEvent),
  };
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return finiteNumber(value, label);
}

function parseUsage(value: unknown): Usage | undefined {
  if (value === undefined) return undefined;
  const usage = record(value, "compaction result.usage");
  const cost = record(usage.cost, "compaction result.usage.cost");
  return {
    input: finiteNumber(usage.input, "compaction result.usage.input"),
    output: finiteNumber(usage.output, "compaction result.usage.output"),
    cacheRead: finiteNumber(usage.cacheRead, "compaction result.usage.cacheRead"),
    cacheWrite: finiteNumber(usage.cacheWrite, "compaction result.usage.cacheWrite"),
    reasoning: optionalNumber(usage.reasoning, "compaction result.usage.reasoning"),
    totalTokens: finiteNumber(usage.totalTokens, "compaction result.usage.totalTokens"),
    cost: {
      input: finiteNumber(cost.input, "compaction result.usage.cost.input"),
      output: finiteNumber(cost.output, "compaction result.usage.cost.output"),
      cacheRead: finiteNumber(cost.cacheRead, "compaction result.usage.cost.cacheRead"),
      cacheWrite: finiteNumber(cost.cacheWrite, "compaction result.usage.cost.cacheWrite"),
      total: finiteNumber(cost.total, "compaction result.usage.cost.total"),
    },
  };
}

export function parseCompactionResult(value: unknown): CompactionResult {
  const result = record(value, "compaction result");
  if (typeof result.summary !== "string")
    throw new Error("compaction result.summary must be a string");
  let details: CompactionDetails | undefined;
  if (result.details !== undefined) {
    const rawDetails = record(result.details, "compaction result.details");
    if (rawDetails.readFiles !== undefined && !Array.isArray(rawDetails.readFiles)) {
      throw new Error("compaction result.details.readFiles must be an array");
    }
    details = { readFiles: rawDetails.readFiles as unknown[] | undefined };
  }
  return {
    summary: result.summary,
    firstKeptEntryId: optionalString(result.firstKeptEntryId, "compaction result.firstKeptEntryId"),
    tokensBefore: optionalNumber(result.tokensBefore, "compaction result.tokensBefore"),
    usage: parseUsage(result.usage),
    details,
  };
}

export function parseCompactionEndEvent(message: RpcMessage): CompactionEndEvent {
  if (message.type !== "compaction_end")
    throw new Error(`expected compaction_end, got ${message.type}`);
  if (message.aborted === undefined) throw new Error("compaction_end.aborted must be a boolean");
  return { ...message, aborted: message.aborted, result: parseCompactionResult(message.result) };
}

export interface RpcHarnessOptions {
  name: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  defaultTimeout?: number;
}

export function isolateAgentDir(name: string, logdir: string, customAgentDir?: string): string {
  const realDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const sandbox = join(logdir, `agent-${name}`);
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  for (const file of ["auth.json", "models.json", "models-store.json"]) {
    const src = join(realDir, file);
    if (existsSync(src)) copyFileSync(src, join(sandbox, file));
  }
  if (customAgentDir) {
    for (const file of ["settings.json", "auth.json", "models.json", "models-store.json"]) {
      const src = join(customAgentDir, file);
      if (existsSync(src)) copyFileSync(src, join(sandbox, file));
    }
  }
  const modelsStorePath = join(sandbox, "models-store.json");
  const modelsStore = existsSync(modelsStorePath)
    ? record(JSON.parse(readFileSync(modelsStorePath, "utf8")), "models store")
    : {};
  modelsStore.doppelclaude = {
    models: [],
    supportedModelIds: ["claude-haiku-4-5"],
  };
  writeFileSync(modelsStorePath, JSON.stringify(modelsStore));
  const settingsPath = join(sandbox, "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...settings,
        doppelclaude: { provider: { systemPromptMode: "claude-code" } },
      },
      null,
      2,
    ),
  );
  return sandbox;
}

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Auto-load .env.test so int tests work when invoked directly
// (`node --import tsx --test tests/int-foo.ts`) and not just via `npm test`.
const ENV_FILE = resolve(DIR, ".env.test");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/** Create an RPC harness for pi integration tests. */
export function createRpcHarness(opts: RpcHarnessOptions) {
  const { name, args = [], env = {}, cwd = DIR, defaultTimeout = 30_000 } = opts;

  const LOGDIR = `${DIR}/.test-output`;
  mkdirSync(LOGDIR, { recursive: true });

  const RPC_LOG = `${LOGDIR}/${name}.log`;
  const DEBUG_LOG = `${LOGDIR}/${name}-debug.log`;
  const AGENT_DIR = isolateAgentDir(name, LOGDIR, env.PI_CODING_AGENT_DIR);

  // Strip any local node_modules from PATH so we use the globally-installed `pi`.
  const cleanPath = process.env.PATH.split(":")
    .filter((p) => !p.includes("node_modules"))
    .join(":");

  let pi: ChildProcess;
  let rpcLog: WriteStream;
  let buffer = "";
  let listeners: Array<(msg: RpcMessage) => void> = [];
  let reqId = 0;

  function start() {
    // Truncate the debug log on each run so test assertions that grep the
    // log see only this run's output, not accumulated history from prior
    // failing runs. RPC log is still append so cross-run comparisons work.
    writeFileSync(DEBUG_LOG, "");
    rpcLog = createWriteStream(RPC_LOG, { flags: "a" });
    const spawnArgs = ["--no-session", "-ne", "-e", DIR, "--mode", "rpc", ...args];
    pi = spawn("pi", spawnArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
        PATH: cleanPath,
        PI_CODING_AGENT_DIR: AGENT_DIR,
        DOPPELCLAUDE_DEBUG: "1",
        DOPPELCLAUDE_DEBUG_PATH: DEBUG_LOG,
        CLAUDE_CODE_SAFE_MODE: "1",
      },
    });

    pi.stderr.on("data", (d) => rpcLog.write(d));

    const decoder = new StringDecoder("utf8");
    pi.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      while (true) {
        const i = buffer.indexOf("\n");
        if (i === -1) break;
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        try {
          const msg = parseRpcMessage(JSON.parse(line));
          rpcLog.write(`< ${line}\n`);
          for (const fn of [...listeners]) fn(msg);
        } catch (error) {
          rpcLog.write(
            `! invalid RPC message: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    });
  }

  async function startAndWait(ms = 2000) {
    start();
    await new Promise((r) => setTimeout(r, ms));
  }

  async function stop() {
    if (pi && pi.exitCode === null) {
      const closed = new Promise<void>((resolve) => pi.once("close", () => resolve()));
      pi.stdin.end();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), 10_000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!exited) {
        pi.kill();
        await closed;
      }
    }
    if (rpcLog) await new Promise((resolve) => rpcLog.end(resolve));
  }

  function addListener(fn: (msg: RpcMessage) => void) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i !== -1) listeners.splice(i, 1);
    };
  }

  type Parser<T> = (value: unknown) => T;

  function send(cmd: Record<string, unknown>, timeout?: number): Promise<void>;
  function send<T>(cmd: Record<string, unknown>, timeout: number, parse: Parser<T>): Promise<T>;
  function send<T>(
    cmd: Record<string, unknown>,
    timeout = defaultTimeout,
    parse?: Parser<T>,
  ): Promise<T | undefined> {
    const id = `req_${++reqId}`;
    const full = { ...cmd, id };
    rpcLog.write(`> ${JSON.stringify(full)}\n`);
    pi.stdin.write(`${JSON.stringify(full)}\n`);
    return new Promise<T | undefined>((resolve, reject) => {
      let remove = () => {};
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Timeout: ${cmd.type}`));
      }, timeout);
      remove = addListener((msg) => {
        if (msg.type !== "response" || msg.id !== id) return;
        clearTimeout(timer);
        remove();
        if (!msg.success) {
          reject(new Error(`${cmd.type}: ${msg.error}`));
          return;
        }
        try {
          resolve(parse ? parse(msg.data) : undefined);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function waitForEvent(type: string, timeout = defaultTimeout): Promise<RpcMessage> {
    return new Promise<RpcMessage>((resolve, reject) => {
      let remove = () => {};
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Timeout waiting for ${type}`));
      }, timeout);
      remove = addListener((msg) => {
        if (msg.type === type) {
          clearTimeout(timer);
          remove();
          resolve(msg);
        }
      });
    });
  }

  function waitForMatch(
    predicate: (msg: RpcMessage) => boolean,
    description: string,
    timeout = defaultTimeout,
  ): Promise<RpcMessage> {
    return new Promise<RpcMessage>((resolve, reject) => {
      let remove = () => {};
      const timer = setTimeout(() => {
        remove();
        reject(new Error(`Timeout waiting for ${description}`));
      }, timeout);
      remove = addListener((msg) => {
        if (predicate(msg)) {
          clearTimeout(timer);
          remove();
          resolve(msg);
        }
      });
    });
  }

  function collectText() {
    let text = "";
    const handler = (msg: RpcMessage) => {
      if (msg.type === "message_update") {
        const ae = msg.assistantMessageEvent;
        if (ae?.type === "text_delta") text += ae.delta;
      }
    };
    addListener(handler);
    return {
      stop() {
        const i = listeners.indexOf(handler);
        if (i !== -1) listeners.splice(i, 1);
        return text;
      },
    };
  }

  async function promptAndWait(message: string, timeout = defaultTimeout): Promise<string> {
    const collector = collectText();
    await send({ type: "prompt", message }, timeout);
    await waitForEvent("agent_end", timeout);
    return collector.stop();
  }

  function clearListeners() {
    listeners = [];
  }

  return {
    DIR,
    LOGDIR,
    RPC_LOG,
    DEBUG_LOG,
    pi: () => pi,
    start,
    startAndWait,
    stop,
    addListener,
    clearListeners,
    send,
    waitForEvent,
    waitForMatch,
    collectText,
    promptAndWait,
  };
}

/** Require an environment variable or exit with an error. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: ${name} not set (see .env.test)`);
    process.exit(1);
  }
  return value;
}
