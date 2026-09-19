import { MCP_TOOL_PREFIX } from "./skills.js";

/** Marker for a tool name Claude Code declined to dispatch. Nothing in pi can
 *  answer to it, so the call persists in pi's record as a not-found failure. */
export const CC_REJECTED_TOOL_PREFIX = "cc_no_such_tool__";

export function isCcRejectedToolName(name: string): boolean {
  return name.startsWith(CC_REJECTED_TOOL_PREFIX);
}

export function mapSdkToolNameToPi(name: string, customToolNameToPi?: Map<string, string>): string {
  const custom = customToolNameToPi?.get(name) ?? customToolNameToPi?.get(name.toLowerCase());
  if (custom) return custom;
  return `${CC_REJECTED_TOOL_PREFIX}${name}`;
}

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id);
  if (existing) return existing;
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  cache.set(id, clean);
  return clean;
}

/** A pi tool name as the name a rebuilt transcript has to call it by.
 *
 *  Every tool Claude can call is a pi tool served over MCP as
 *  `mcp__custom-tools__<pi name>` (resolveMcpTools); the map is consulted first
 *  only because it carries the served tool's exact casing. A name it lacks is a
 *  tool pi ran that we do not serve now — an extension since disabled — and it
 *  keeps the MCP namespace too: naming it after a Claude Code builtin would tell
 *  the model a builtin it cannot call is available and was already used. */
export function mapPiToolNameToSdk(
  name: string,
  customToolNameToSdk?: Map<string, string>,
): string {
  if (!name) return "";
  if (isCcRejectedToolName(name)) return name.slice(CC_REJECTED_TOOL_PREFIX.length);
  // Pi history holds pi tool names. Our own SDK prefix can only reach here by
  // feeding already-converted names back through the conversion, and prefixing
  // twice invents a tool nobody serves.
  if (name.toLowerCase().startsWith(MCP_TOOL_PREFIX)) {
    throw new Error(
      `mapPiToolNameToSdk: "${name}" is already an SDK tool name — pi history holds pi tool names`,
    );
  }
  const mapped = customToolNameToSdk?.get(name) ?? customToolNameToSdk?.get(name.toLowerCase());
  return mapped ?? `${MCP_TOOL_PREFIX}${name}`;
}
