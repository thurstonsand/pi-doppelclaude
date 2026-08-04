import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  McpServerConfig,
  McpSetServersResult,
  Query,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  apiStatusFailure,
  assistantApiFailure,
  awaitQueryInitialization,
  classifyResult,
  formatRateLimitMessage,
  reconcileMcpServers,
} from "../src/sdk-signals.js";

function queryWithSetMcpServers(
  results: McpSetServersResult[],
  calls: Array<Record<string, McpServerConfig>>,
): Query {
  const sdkQuery = Object.create(null) as Query;
  sdkQuery.setMcpServers = async (servers) => {
    calls.push(servers);
    const result = results.shift();
    if (!result) throw new Error("unexpected setMcpServers call");
    return result;
  };
  return sdkQuery;
}

const server = { type: "sdk", name: "custom-tools", instance: {} } as unknown as McpServerConfig;

describe("Agent SDK runtime signals", () => {
  it("reconciles MCP server addition", async () => {
    const calls: Array<Record<string, McpServerConfig>> = [];
    const sdkQuery = queryWithSetMcpServers(
      [{ added: ["custom-tools"], removed: [], errors: {} }],
      calls,
    );
    await reconcileMcpServers(sdkQuery, "custom-tools", false, { "custom-tools": server });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]["custom-tools"], server);
  });

  it("reconciles MCP replacement as remove then add", async () => {
    const calls: Array<Record<string, McpServerConfig>> = [];
    const sdkQuery = queryWithSetMcpServers(
      [
        { added: [], removed: ["custom-tools"], errors: {} },
        { added: ["custom-tools"], removed: [], errors: {} },
      ],
      calls,
    );
    await reconcileMcpServers(sdkQuery, "custom-tools", true, { "custom-tools": server });
    assert.deepEqual(calls[0], {});
    assert.equal(calls[1]["custom-tools"], server);
  });

  it("reconciles MCP server removal", async () => {
    const calls: Array<Record<string, McpServerConfig>> = [];
    const sdkQuery = queryWithSetMcpServers(
      [{ added: [], removed: ["custom-tools"], errors: {} }],
      calls,
    );
    await reconcileMcpServers(sdkQuery, "custom-tools", true, {});
    assert.deepEqual(calls, [{}]);
  });

  it("rejects MCP reconciliation errors and missing receipts", async () => {
    const failed = queryWithSetMcpServers(
      [{ added: [], removed: [], errors: { "custom-tools": "connection failed" } }],
      [],
    );
    await assert.rejects(
      () => reconcileMcpServers(failed, "custom-tools", false, { "custom-tools": server }),
      /connection failed/,
    );

    const unconfirmed = queryWithSetMcpServers([{ added: [], removed: [], errors: {} }], []);
    await assert.rejects(
      () => reconcileMcpServers(unconfirmed, "custom-tools", false, { "custom-tools": server }),
      /did not confirm/,
    );
  });

  it("waits for query initialization without an extra MCP status request", async () => {
    let initialized = false;
    const sdkQuery = Object.create(null) as Query;
    sdkQuery.initializationResult = async () => {
      initialized = true;
      return {} as Awaited<ReturnType<Query["initializationResult"]>>;
    };
    sdkQuery.mcpServerStatus = async () => {
      throw new Error("unexpected status request");
    };
    await awaitQueryInitialization(sdkQuery);
    assert.equal(initialized, true);
  });

  it("maps HTTP 429 and 529 classifications", () => {
    assert.equal(assistantApiFailure("rate_limit"), "Claude API rate limit (HTTP 429)");
    assert.equal(assistantApiFailure("overloaded"), "Claude API overloaded (HTTP 529)");
    assert.equal(apiStatusFailure(429), "Claude API rate limit (HTTP 429)");
    assert.equal(apiStatusFailure(529), "Claude API overloaded (HTTP 529)");
    assert.equal(apiStatusFailure(500), null);
  });

  it("formats model-scoped quota and credit details", () => {
    const message = formatRateLimitMessage({
      status: "rejected",
      rateLimitType: "seven_day_opus",
      utilization: 1,
      resetsAt: Date.parse("2026-07-25T12:00:00.000Z"),
      errorCode: "credits_required",
      canUserPurchaseCredits: false,
    });
    assert.match(message, /Opus weekly limit/);
    assert.match(message, /100% used/);
    const localReset = new Date(Date.parse("2026-07-25T12:00:00.000Z")).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    assert.ok(message.includes(`resets ${localReset}`), message);
    assert.match(message, /credits required/);
  });

  it("classifies reusable, interrupted, and terminal results once", () => {
    const result = (terminal_reason: SDKResultMessage["terminal_reason"], is_error = false) =>
      ({
        type: "result",
        subtype: "success",
        terminal_reason,
        is_error,
      }) as SDKResultMessage;
    assert.deepEqual(classifyResult(result("completed"), null, null), { type: "reusable" });
    assert.deepEqual(classifyResult(result("aborted_streaming"), null, null), {
      type: "interrupted",
      message: "Claude query ended with aborted_streaming",
    });
    assert.deepEqual(classifyResult(result("blocking_limit"), "quota rejected", "quota rejected"), {
      type: "terminal",
      message: "quota rejected",
    });
  });
});
