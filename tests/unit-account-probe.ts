import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AccountInfo, ModelInfo, Options } from "@anthropic-ai/claude-agent-sdk";
import { createAccountProbe } from "doppelclaude/account-probe";

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
    pathToClaudeCodeExecutable: "/configured/claude",
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
    assert.equal(options.abortController.signal.aborted, true);
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.deepEqual(options?.tools, []);
    assert.deepEqual(options?.mcpServers, {});
    assert.equal(options?.strictMcpConfig, true);
    assert.deepEqual(options?.settingSources, []);
    assert.deepEqual(options?.skills, []);
    assert.equal(options?.persistSession, false);
    assert.equal(options?.pathToClaudeCodeExecutable, "/configured/claude");
  });

  it("passes a subscription OAuth token through the neutral child environment", async () => {
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-subscription-token";
    let options: Options | undefined;
    try {
      await probeFor({ apiProvider: "firstParty", tokenSource: "oauth" }, undefined, (value) => {
        options = value;
      })();
      assert.equal(options?.env?.CLAUDE_CODE_OAUTH_TOKEN, "test-subscription-token");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
    }
  });

  it("accepts OAuth when the SDK reports apiKeySource none", async () => {
    assert.equal(
      (
        await probeFor({
          apiProvider: "firstParty",
          tokenSource: "oauth",
          apiKeySource: "none",
        })()
      ).available,
      true,
    );
  });

  it("rejects an active API key even when the provider is first-party", async () => {
    await assert.rejects(
      probeFor({ apiProvider: "firstParty", apiKeySource: "environment" })(),
      /API key instead of a subscription.*claude auth login/u,
    );
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
    let options: Options | undefined;
    await assert.rejects(
      probeFor(
        { apiProvider: "firstParty", email: 42 },
        () => {
          closes++;
        },
        (value) => {
          options = value;
        },
      )(),
      /malformed account information.*claude auth login/,
    );
    assert.equal(closes, 1);
    assert.equal(options?.abortController?.signal.aborted, true);
  });

  it("turns control Query failures into actionable diagnostics", async () => {
    let closes = 0;
    let options: Options | undefined;
    const probe = createAccountProbe({
      queryFactory(request) {
        options = request.options;
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
    assert.equal(options?.abortController?.signal.aborted, true);
  });

  it("propagates caller cancellation to the SDK and settles promptly", async () => {
    let options: Options | undefined;
    const probe = createAccountProbe({
      queryFactory(request) {
        options = request.options;
        return {
          accountInfo: () => new Promise<AccountInfo>(() => {}),
          supportedModels: () => new Promise<ModelInfo[]>(() => {}),
          close() {},
        };
      },
    });
    const controller = new AbortController();
    const result = probe(controller.signal);
    controller.abort(new Error("stopping"));

    await assert.rejects(result, /stopping/u);
    assert.equal(options?.abortController?.signal.aborted, true);
  });
});
