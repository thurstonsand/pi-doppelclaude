import type {
  McpServerConfig,
  McpSetServersResult,
  Query,
  SDKAssistantMessageError,
  SDKRateLimitInfo,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** Claude Code stamps messages it fabricated locally — API error envelopes, placeholder
 *  turns — with this in place of a model id. It never names a model that served anything. */
export const SYNTHETIC_MODEL_ID = "<synthetic>";

export function isSyntheticModelId(id: string | undefined): boolean {
  return id === SYNTHETIC_MODEL_ID;
}

function assertMcpResult(
  action: string,
  result: McpSetServersResult,
  expectedServer: string,
  expectedField: "added" | "removed",
): void {
  const errors = Object.entries(result.errors);
  if (errors.length > 0) {
    throw new Error(
      `Claude MCP ${action} failed: ${errors.map(([name, error]) => `${name}: ${error}`).join("; ")}`,
    );
  }
  if (!result[expectedField].includes(expectedServer)) {
    throw new Error(`Claude MCP ${action} did not confirm ${expectedServer}`);
  }
}

export async function reconcileMcpServers(
  sdkQuery: Query,
  serverName: string,
  hadServer: boolean,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const hasServer = Object.hasOwn(servers, serverName);
  if (hadServer) {
    const removed = await sdkQuery.setMcpServers({});
    assertMcpResult("removal", removed, serverName, "removed");
  }
  if (hasServer) {
    const added = await sdkQuery.setMcpServers(servers);
    assertMcpResult("addition", added, serverName, "added");
  }
}

export async function awaitQueryInitialization(sdkQuery: Query): Promise<void> {
  await sdkQuery.initializationResult();
}

// No limit window runs longer than a week, so the year would never disambiguate anything.
const RESET_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

function resetText(resetsAt: number | undefined): string | null {
  if (resetsAt === undefined) return null;
  const reset = new Date(resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt);
  if (Number.isNaN(reset.valueOf())) return String(resetsAt);
  // The reader has to decide whether to wait it out, so the wall clock they are reading it on
  // is the only useful frame.
  return reset.toLocaleString(undefined, RESET_FORMAT);
}

function limitName(type: SDKRateLimitInfo["rateLimitType"]): string {
  switch (type) {
    case "five_hour":
      return "5-hour limit";
    case "seven_day":
      return "weekly limit";
    case "seven_day_opus":
      return "Opus weekly limit";
    case "seven_day_sonnet":
      return "Sonnet weekly limit";
    case "seven_day_overage_included":
      return "weekly included-usage limit";
    case "overage":
      return "Extra Usage limit";
    case undefined:
      return "usage limit";
  }
}

export function formatRateLimitMessage(info: SDKRateLimitInfo): string {
  const parts = [`Claude ${limitName(info.rateLimitType)}`];
  if (info.status === "allowed_warning") parts.push("warning");
  else if (info.status === "rejected") parts.push("rejected");
  // The CLI reports the consumed fraction, 0.0-1.0 — unlike the `/usage` endpoint, which
  // reports the same quantity already scaled to 0-100.
  if (info.utilization !== undefined) parts.push(`${Math.round(info.utilization * 100)}% used`);
  const reset = resetText(info.resetsAt);
  if (reset) parts.push(`resets ${reset}`);
  if (info.errorCode === "credits_required") {
    parts.push(
      info.canUserPurchaseCredits
        ? "Extra Usage credits can be purchased"
        : "Extra Usage credits required",
    );
  }
  if (info.overageDisabledReason)
    parts.push(`Extra Usage unavailable: ${info.overageDisabledReason.replaceAll("_", " ")}`);
  return parts.join(" — ");
}

export function assistantApiFailure(error: SDKAssistantMessageError | undefined): string | null {
  switch (error) {
    case "rate_limit":
      return "Claude API rate limit (HTTP 429)";
    case "overloaded":
      return "Claude API overloaded (HTTP 529)";
    default:
      return null;
  }
}

export function apiStatusFailure(status: number | null | undefined): string | null {
  if (status === 429) return "Claude API rate limit (HTTP 429)";
  if (status === 529) return "Claude API overloaded (HTTP 529)";
  return null;
}

export type ResultVerdict =
  | { type: "reusable" }
  | { type: "interrupted"; message: string }
  | { type: "terminal"; message: string };

function combineFailure(primary: string | null, detail: string | null): string | null {
  if (!primary) return detail;
  if (!detail || detail === primary) return primary;
  return `${primary}: ${detail}`;
}

export function classifyResult(
  result: SDKResultMessage,
  structuredFailure: string | null,
  detail: string | null,
): ResultVerdict {
  const failure = combineFailure(structuredFailure, detail);
  if (
    result.terminal_reason === "aborted_streaming" ||
    result.terminal_reason === "aborted_tools"
  ) {
    return {
      type: "interrupted",
      message: failure ?? `Claude query ended with ${result.terminal_reason}`,
    };
  }
  if (
    result.subtype === "success" &&
    !result.is_error &&
    !failure &&
    (result.terminal_reason === undefined || result.terminal_reason === "completed")
  ) {
    return { type: "reusable" };
  }
  return { type: "terminal", message: failure ?? describeBareFailure(result) };
}

/** Last resort: the result flagged a failure and nothing anywhere said what it was. Naming a
 *  terminal_reason of `completed` or a subtype of `success` would contradict the failure. */
function describeBareFailure(result: SDKResultMessage): string {
  if (result.terminal_reason && result.terminal_reason !== "completed")
    return `Claude query ended with ${result.terminal_reason}`;
  if (result.subtype !== "success") return `Claude query ended with ${result.subtype}`;
  return "Claude Code reported a failed turn without saying why";
}
