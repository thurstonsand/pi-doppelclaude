#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runHttpDaemon } from "./startup.js";

const HELP = `Usage: doppelclaude-serve [--help | --version]

Serve the Anthropic Messages API (default bind: 127.0.0.1:3456).
Startup account and binary-cap probes have a combined 30-second deadline.

Environment:
  DOPPELCLAUDE_HTTP_API_KEY       API key accepted from clients (required*)
  DOPPELCLAUDE_HTTP_API_KEY_FILE  File containing that API key (required*)
  DOPPELCLAUDE_HTTP_HOST          Listen IP literal (default: 127.0.0.1)
  DOPPELCLAUDE_STATE_DIR          State and log directory
  PORT                            Listen port (default: 3456)
  DOPPELCLAUDE_MAX_RUNTIMES       Maximum live conversation runtimes (32)
  DOPPELCLAUDE_IDLE_TTL_MS        Runtime idle lifetime (3600000)
  DOPPELCLAUDE_MAX_BODY_BYTES     Maximum request body size (2097152)
  DOPPELCLAUDE_REQUEST_TIMEOUT_MS Request deadline (600000)
  DOPPELCLAUDE_SHUTDOWN_TIMEOUT_MS Graceful shutdown deadline (15000)
  DOPPELCLAUDE_RETRY_ATTEMPTS     Transient retry count (2)
  DOPPELCLAUDE_DEBUG              Set to 1 to enable bridge debug logging
  CLAUDE_CODE_OAUTH_TOKEN         Passed unchanged to Claude Code
  CLAUDE_CONFIG_DIR               Passed unchanged to Claude Code

* Set exactly one API key variable.
`;

async function version(): Promise<string> {
  const manifest = new URL("../package.json", import.meta.url);
  const value = JSON.parse(await readFile(fileURLToPath(manifest), "utf8")) as { version: string };
  return value.version;
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    process.stdout.write(`http-doppelclaude ${await version()}\n`);
    return;
  }
  if (args.length > 0) throw new Error(`unexpected argument${args.length > 1 ? "s" : ""}`);
  await runHttpDaemon();
}

function sanitizedError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const configuredSecrets = [
    process.env.DOPPELCLAUDE_HTTP_API_KEY,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ].filter((value): value is string => Boolean(value));
  for (const secret of configuredSecrets) message = message.replaceAll(secret, "[REDACTED]");
  return message
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]+|Bearer\s+[^\s,;]+)/giu, "[REDACTED]")
    .replace(
      /\b(?:api[_ -]?key|oauth[_ -]?token|authorization)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`doppelclaude-serve: startup failed: ${sanitizedError(error)}\n`);
  process.exitCode = 1;
});
