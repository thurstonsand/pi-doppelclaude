// Bridge logging, diagnostics, and per-query SDK debug options.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BridgeSettings } from "./settings.js";

export let DEBUG = false;
let debugLogPath = join(getAgentDir(), "doppelclaude.log");
const DIAG_LOG_PATH = join(getAgentDir(), "doppelclaude-diag.log");

export function configureDebug(settings: BridgeSettings["debug"]): void {
  DEBUG = settings.enabled;
  debugLogPath = settings.logPath;
  if (!DEBUG) return;
  try {
    mkdirSync(dirname(debugLogPath), { recursive: true });
    mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
  } catch {
    // The first attempted write will preserve the filesystem error.
  }
}

// Unique per module evaluation — confirms whether subagents share module state
export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

export function debug(...args: unknown[]) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
    return JSON.stringify(a);
  };
  const msg = args.map(fmt).join(" ");
  appendFileSync(debugLogPath, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When DOPPELCLAUDE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
export function makeCliDebugOptions(tag: string): {
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
} {
  if (!DEBUG) return {};
  const seq = nextCliDebugSeq++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(dirname(debugLogPath), "cc-cli-logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
  debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
  return {
    debug: true,
    debugFile,
    stderr: (data: string) => {
      for (const line of data.split(/\r?\n/)) {
        if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
      }
    },
  };
}

/** Unconditional diagnostic dump — for "should never happen" paths */
export function diagDump(label: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const entry = { ts, moduleInstanceId, label, ...data };
  appendFileSync(DIAG_LOG_PATH, `${JSON.stringify(entry)}\n`);
  debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

// DOPPELCLAUDE_RECORD_STREAM=<path> appends every SDK message consumeQuery sees,
// one JSON object per line. Used by tests/lib/record-sdk-streams.ts to capture
// the replay fixtures behind tests/unit-stream-replay.ts.
const RECORD_STREAM_PATH = process.env.DOPPELCLAUDE_RECORD_STREAM;

export function recordSdkMessage(message: unknown): void {
  if (RECORD_STREAM_PATH) appendFileSync(RECORD_STREAM_PATH, `${JSON.stringify(message)}\n`);
}
