import { execSync } from "node:child_process";
import { errorMessage } from "./errors.js";
import type { ProviderSettings } from "./settings.js";

export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

// Long enough for a password manager to ask for a fingerprint and be answered.
const COMMAND_TIMEOUT_MS = 60_000;

export interface OauthTokenDependencies {
  providerSettings: ProviderSettings;
  env: NodeJS.ProcessEnv;
  runCommand(command: string): string;
  debug(...args: unknown[]): void;
}

/** Runs the command in the platform shell and returns its stdout. Failure carries its stderr. */
export function runShellCommand(command: string): string {
  return execSync(command, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Populates the OAuth token in `env` from `provider.oauthTokenCommand`, so every Claude Code
 * subprocess inherits it. An inherited token wins: the environment is the more specific answer,
 * and re-running the command would only confirm what the caller already decided.
 */
export function resolveOauthToken(dependencies: OauthTokenDependencies): void {
  const { providerSettings, env, runCommand, debug } = dependencies;
  const command = providerSettings.oauthTokenCommand;
  if (!command) return;
  if (env[OAUTH_TOKEN_ENV]) {
    debug(`oauthToken: ${OAUTH_TOKEN_ENV} already set, leaving provider.oauthTokenCommand unrun`);
    return;
  }

  let output: string;
  try {
    output = runCommand(command);
  } catch (err) {
    throw new Error(
      `doppelclaude: doppelclaude.provider.oauthTokenCommand failed: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  const token = output.trim();
  if (!token) {
    throw new Error(
      "doppelclaude: doppelclaude.provider.oauthTokenCommand produced no token on stdout",
    );
  }
  env[OAUTH_TOKEN_ENV] = token;
  debug(`oauthToken: resolved ${OAUTH_TOKEN_ENV} from provider.oauthTokenCommand`);
}
