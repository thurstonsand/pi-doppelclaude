import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OAUTH_TOKEN_ENV, resolveOauthToken, runShellCommand } from "../src/oauth-token.js";
import type { ProviderSettings } from "../src/settings.js";

function providerSettings(oauthTokenCommand?: string): ProviderSettings {
  return { systemPromptMode: "claude-code", ...(oauthTokenCommand ? { oauthTokenCommand } : {}) };
}

function resolve(
  settings: ProviderSettings,
  env: NodeJS.ProcessEnv,
  runCommand: (command: string) => string,
) {
  const commands: string[] = [];
  resolveOauthToken({
    providerSettings: settings,
    env,
    runCommand: (command) => {
      commands.push(command);
      return runCommand(command);
    },
    debug: () => {},
  });
  return commands;
}

describe("resolveOauthToken", () => {
  it("puts the command's trimmed stdout in the environment", () => {
    const env: NodeJS.ProcessEnv = {};
    const commands = resolve(providerSettings("print-token"), env, () => "sk-ant-oat01-secret\n");
    assert.deepEqual(commands, ["print-token"]);
    assert.equal(env[OAUTH_TOKEN_ENV], "sk-ant-oat01-secret");
  });

  it("leaves an inherited token alone and never runs the command", () => {
    const env: NodeJS.ProcessEnv = { [OAUTH_TOKEN_ENV]: "sk-ant-oat01-inherited" };
    const commands = resolve(providerSettings("print-token"), env, () => "sk-ant-oat01-other");
    assert.deepEqual(commands, []);
    assert.equal(env[OAUTH_TOKEN_ENV], "sk-ant-oat01-inherited");
  });

  it("does nothing without the setting", () => {
    const env: NodeJS.ProcessEnv = {};
    const commands = resolve(providerSettings(), env, () => "sk-ant-oat01-secret");
    assert.deepEqual(commands, []);
    assert.equal(env[OAUTH_TOKEN_ENV], undefined);
  });

  it("reports a failing command instead of starting unauthenticated", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.throws(
      () =>
        resolve(providerSettings("print-token"), env, () => {
          throw new Error("vault locked");
        }),
      /oauthTokenCommand failed: vault locked/,
    );
    assert.equal(env[OAUTH_TOKEN_ENV], undefined);
  });

  it("rejects a command that prints nothing", () => {
    const env: NodeJS.ProcessEnv = {};
    assert.throws(
      () => resolve(providerSettings("print-token"), env, () => "  \n"),
      /produced no token on stdout/,
    );
    assert.equal(env[OAUTH_TOKEN_ENV], undefined);
  });
});

describe("runShellCommand", () => {
  it("returns stdout from the platform shell", () => {
    assert.equal(runShellCommand("printf 'sk-ant-oat01-shell'"), "sk-ant-oat01-shell");
  });

  it("carries stderr into the failure so the cause is visible", () => {
    assert.throws(() => runShellCommand("printf 'no such vault' >&2; exit 3"), /no such vault/);
  });
});
