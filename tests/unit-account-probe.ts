import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountInfo, ModelInfo, Options } from "@anthropic-ai/claude-agent-sdk";
import { createAccountProbe } from "../src/account-probe.js";

const supportedModels: ModelInfo[] = [
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5[1m]",
    displayName: "Opus",
    description: "Opus 5",
  },
];

function probeFor(
  account: unknown,
  onClose = () => {},
  captureOptions = (_options: Options | undefined) => {},
) {
  return createAccountProbe({
    providerSettings: {
      systemPromptMode: "claude-code",
      pathToClaudeCodeExecutable: "/configured/claude",
    },
    queryFactory(request) {
      captureOptions(request.options);
      return {
        accountInfo: async () => account as AccountInfo,
        supportedModels: async () => supportedModels,
        close: onClose,
      };
    },
  });
}

describe("Claude Code account probe", () => {
  it("accepts a first-party account and closes the control Query", async () => {
    let closes = 0;
    let options: Options | undefined;
    const probe = probeFor(
      { apiProvider: "firstParty", email: "discard@example.com", organization: "Discarded" },
      () => {
        closes++;
      },
      (value) => {
        options = value;
      },
    );
    assert.deepEqual(await probe(), { available: true, supportedModels });
    assert.equal(closes, 1);
    assert.ok(options?.abortController instanceof AbortController);
    assert.deepEqual(options?.tools, []);
    assert.deepEqual(options?.settingSources, []);
    assert.deepEqual(options?.skills, []);
    assert.equal(options?.persistSession, false);
    assert.equal(options?.pathToClaudeCodeExecutable, "/configured/claude");
  });

  it("treats the explicit no-token account state as logged out", async () => {
    assert.equal((await probeFor({ apiProvider: "firstParty" })()).available, false);
    assert.equal((await probeFor({})()).available, false);
    assert.equal(
      (await probeFor({ apiProvider: "firstParty", tokenSource: "none", apiKeySource: "none" })())
        .available,
      false,
    );
  });

  it("rejects non-first-party backends with login guidance", async () => {
    await assert.rejects(
      probeFor({ apiProvider: "bedrock", tokenSource: "aws" })(),
      /unsupported API provider "bedrock".*claude auth login/,
    );
  });

  it("rejects an authenticated account whose API provider is missing", async () => {
    await assert.rejects(
      probeFor({ email: "user@example.com", subscriptionType: "Claude Max" })(),
      /authenticated account without an API provider.*claude auth login/,
    );
  });

  it("rejects malformed account information and still closes the Query", async () => {
    let closes = 0;
    await assert.rejects(
      probeFor({ apiProvider: "firstParty", email: 42 }, () => {
        closes++;
      })(),
      /malformed account information.*claude auth login/,
    );
    assert.equal(closes, 1);
  });

  it("turns control Query failures into actionable diagnostics", async () => {
    let closes = 0;
    const probe = createAccountProbe({
      providerSettings: { systemPromptMode: "claude-code" },
      queryFactory() {
        return {
          accountInfo: async () => {
            throw new Error("control channel failed");
          },
          supportedModels: async () => supportedModels,
          close: () => {
            closes++;
          },
        };
      },
    });
    await assert.rejects(probe(), /control channel failed.*claude auth login/);
    assert.equal(closes, 1);
  });
});
