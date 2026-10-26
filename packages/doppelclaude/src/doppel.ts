// Doppels: the Claude Code counterpart of one pi conversation.
//
// A doppel owns the Claude Code session its conversation resumes, the query contexts
// that speak for it, and the sync that keeps that session in step with pi's history.
// The registry maps caller identity onto doppels — the host session pi designates at
// session_start, guests naming some other pi session, and ephemerals for the keyless
// auxiliary calls (auto-title, working vibes) that get a synthetic key and are dropped
// the moment their turn ends. Nothing here reads another doppel's state, which is what
// makes cross-conversation interference structurally impossible rather than guarded
// against.

import { randomUUID } from "node:crypto";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import {
  type ContentBlock,
  createSession,
  type ImportAttachment,
  repairToolPairing,
  type Session,
} from "cc-session-io";
import { debug } from "./debug.js";
import { QueryContext } from "./query-state.js";
import type { BridgeSessionStore } from "./session-store.js";
import { sanitizeToolId } from "./tool-names.js";

export type DoppelKind = "host" | "guest" | "ephemeral";

export interface SessionState {
  sessionId: string;
  cursor: number;
  // Force the next sync down the REBUILD path when pi has mutated its messages
  // array out from under us (compact, tree navigation, or abort). REBUILD
  // atomically replaces the authoritative store transcript. The string is the
  // cause, carried from the site that set the flag to the sync that consumes it,
  // so one log line names both why a rebuild was forced and where it was decided.
  rebuildReason?: string;
}

export type SyncPath = "reuse" | "rebuild" | "clean-start";

/** Why a plan chose the path it did. Reported on every sync so a rebuild is never
 *  attributable only by correlating separate log lines across a shared process. */
export type SyncReason =
  | { kind: "in-sync" }
  | { kind: "trailing-assistant" }
  | { kind: "no-session" }
  | { kind: "forced"; cause: string }
  | { kind: "history-shrank"; cursor: number; priors: number }
  | { kind: "missed-messages"; missed: number };

export function describeSyncReason(reason: SyncReason): string {
  switch (reason.kind) {
    case "in-sync":
      return "in-sync";
    case "trailing-assistant":
      return "trailing-assistant";
    case "no-session":
      return "no-session";
    case "forced":
      return `forced(${reason.cause})`;
    case "history-shrank":
      return `history-shrank(cursor=${reason.cursor} priors=${reason.priors})`;
    case "missed-messages":
      return `missed-messages(${reason.missed})`;
  }
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the doppel's live session.
//   REBUILD — pi's history diverged, so synthesize a complete Claude Code
//     transcript and atomically replace the SDK session store entry.
//
// The SDK materializes store entries when resuming and owns its required local
// dual-write. The bridge never computes Claude's project path or manipulates
// JSONL files. Session IDs remain stable across every rebuild; per-query writer
// revisions fence late mirror appends after aborts.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics keep their
// useful continuity.
/** A reuse resumes a session, so it always names the one it resumes; the other paths build
 *  their own and carry the previous session only to preserve its id. */
export type SyncPlan =
  | {
      path: "reuse";
      priorMessages: MessageParam[];
      previousSession: SessionState;
      advanceCursor: boolean;
      reason: SyncReason;
    }
  | {
      path: "rebuild" | "clean-start";
      priorMessages: MessageParam[];
      previousSession: SessionState | null;
      reason: SyncReason;
    };

export interface SyncResult {
  sessionId: string | null;
  path: SyncPath;
  /** What a rebuild changed on the way into Claude Code's transcript; null on every other path. */
  rebuild: RebuildRendering | null;
}

/** Counts of the compensations a rebuild's import applied, so each can be tracked in production. */
interface ImportCompensations {
  contextAttachments: number;
  emptyToolResults: number;
  sanitizedToolIds: number;
  /** Error results the tool-pairing repair wrote for calls the history never answered. */
  synthesizedToolResults: number;
  /** Results the tool-pairing repair dropped because no call precedes them. */
  droppedToolResults: number;
  /** Replay turn boundaries put back where the previous transcript had them. */
  turnBoundaries: number;
  /** Boundaries the previous transcript had that this history no longer lines up with. */
  skippedTurnBoundaries: number;
}

export interface RebuildRendering extends ImportCompensations {
  /** Whose transcript the carried context records came from. */
  contextSource: "own" | "sibling" | "none";
  /** Where the rebuilt transcript first differs from that one; null without a source. */
  divergence: TranscriptDivergence | null;
}

export class Doppel {
  session: SessionState | null = null;
  /** The doppel's own context: warm and persistent for the host, respawned per turn for everyone else. */
  readonly context: QueryContext;

  constructor(
    readonly key: string,
    public kind: DoppelKind,
  ) {
    this.context = new QueryContext(this);
  }

  /** A throwaway context for a turn that arrives while this doppel's query is still busy. */
  spawnContext(): QueryContext {
    return new QueryContext(this);
  }

  /** How a doppel names itself in the bridge log. */
  get label(): string {
    return `${this.kind}:${this.key.slice(0, 8)}`;
  }
}

export interface DoppelRegistry {
  readonly hostKey: string | null;
  /** The host's doppel, created if this is the first turn since a designation or a clear. */
  host(): Doppel;
  /** The doppel a call addresses: its pi session id, or a fresh ephemeral when it names none. */
  resolve(piSessionId: string | undefined): Doppel;
  /** Names the hosting pi session. The outgoing host keeps its state as a guest; the caller closes its query. */
  designate(piSessionId: string): { host: Doppel; demoted: Doppel | null };
  discard(doppel: Doppel): void;
  all(): Doppel[];
  /** Drops every doppel. The host designation survives; its state does not. */
  clear(): void;
}

export function createDoppelRegistry(): DoppelRegistry {
  const doppels = new Map<string, Doppel>();
  let hostKey: string | null = null;

  function resolve(piSessionId: string | undefined): Doppel {
    if (piSessionId === undefined) {
      const ephemeral = new Doppel(randomUUID(), "ephemeral");
      doppels.set(ephemeral.key, ephemeral);
      debug(`doppel: ${ephemeral.label} opened for a keyless call`);
      return ephemeral;
    }
    const existing = doppels.get(piSessionId);
    if (existing) return existing;
    const doppel = new Doppel(piSessionId, piSessionId === hostKey ? "host" : "guest");
    doppels.set(doppel.key, doppel);
    debug(`doppel: ${doppel.label} opened`);
    return doppel;
  }

  return {
    get hostKey() {
      return hostKey;
    },
    host() {
      if (hostKey === null)
        throw new Error("Claude bridge: no pi session has been designated as the host");
      return resolve(hostKey);
    },
    resolve,
    designate(piSessionId) {
      const demoted = hostKey === null ? null : (doppels.get(hostKey) ?? null);
      if (demoted && demoted.key !== piSessionId) demoted.kind = "guest";
      hostKey = piSessionId;
      const host = resolve(piSessionId);
      // A keyed call that arrived before pi named its host opened a guest doppel;
      // the designation upgrades it in place rather than losing its session.
      host.kind = "host";
      return { host, demoted: demoted?.key === piSessionId ? null : demoted };
    },
    discard(doppel) {
      doppels.delete(doppel.key);
    },
    all() {
      return [...doppels.values()];
    },
    clear() {
      doppels.clear();
    },
  };
}

/**
 * Ensure the doppel's session has all messages up to (but not including) the last user
 * message. Pure: the plan is derived before the runtime decides whether the turn is
 * pushed into a live query or spawns a new one, and derived again for a replay.
 */
export function planSessionSync(
  messages: MessageParam[],
  currentSession: SessionState | null,
): SyncPlan {
  return planFor(messages.slice(0, -1), currentSession);
}

/**
 * The plan for a turn whose prompt is not one of pi's messages: a tool-result
 * continuation replayed after its query died. Pi has already delivered everything the
 * turn is answering, so nothing is held back and the whole history is the session's.
 */
export function planReplaySync(
  messages: MessageParam[],
  currentSession: SessionState | null,
): SyncPlan {
  return planFor(messages, currentSession);
}

function planFor(priorMessages: MessageParam[], currentSession: SessionState | null): SyncPlan {
  const reason = diagnose(priorMessages, currentSession);
  if (reason.kind === "in-sync" || reason.kind === "trailing-assistant") {
    // Only the reuse branch proves a session exists, so the narrowing is the diagnosis'.
    if (!currentSession) throw new Error("Claude bridge: reuse diagnosed without a session");
    return {
      path: "reuse",
      priorMessages,
      previousSession: currentSession,
      advanceCursor: reason.kind === "trailing-assistant",
      reason,
    };
  }
  return {
    path: priorMessages.length === 0 ? "clean-start" : "rebuild",
    priorMessages,
    previousSession: currentSession,
    reason,
  };
}

/** The single place that decides a sync path, so the logged reason cannot drift from it. */
function diagnose(priorMessages: MessageParam[], currentSession: SessionState | null): SyncReason {
  if (!currentSession) return { kind: "no-session" };
  if (currentSession.rebuildReason) return { kind: "forced", cause: currentSession.rebuildReason };
  if (priorMessages.length < currentSession.cursor)
    return {
      kind: "history-shrank",
      cursor: currentSession.cursor,
      priors: priorMessages.length,
    };
  const missed = priorMessages.slice(currentSession.cursor);
  if (missed.length === 0) return { kind: "in-sync" };
  if (missed.length === 1 && (missed[0] as { role?: string }).role === "assistant")
    return { kind: "trailing-assistant" };
  return { kind: "missed-messages", missed: missed.length };
}

/** Apply a plan to its doppel: the session it resumes from, and the transcript the store holds. */
export function applySessionSync(input: {
  doppel: Doppel;
  plan: SyncPlan;
  cwd: string;
  sessionStore: BridgeSessionStore;
  modelId?: string;
  /** Another transcript of this same conversation, read when the doppel has none of its own. */
  siblingTranscript?: () => readonly SessionStoreEntry[] | null;
}): SyncResult {
  const { doppel, plan, cwd, sessionStore, modelId } = input;
  const why = describeSyncReason(plan.reason);
  if (plan.path === "reuse") {
    const previous = plan.previousSession;
    doppel.session = plan.advanceCursor
      ? { ...previous, cursor: plan.priorMessages.length }
      : previous;
    debug(
      `Case 3: doppel=${doppel.label} ${plan.advanceCursor ? "advanced cursor past trailing assistant, " : ""}resuming session ${previous.sessionId.slice(0, 8)}, cursor=${doppel.session.cursor}`,
    );
    debug(
      `syncResult: path=reuse doppel=${doppel.label} reason=${why} sessionId=${previous.sessionId} cursor=${doppel.session.cursor}`,
    );
    return { sessionId: previous.sessionId, path: "reuse", rebuild: null };
  }
  if (plan.path === "clean-start") {
    debug(
      `Case 1: doppel=${doppel.label} clean start, ${plan.priorMessages.length + 1} total messages`,
    );
    debug(`syncResult: path=clean-start doppel=${doppel.label} reason=${why}`);
    return { sessionId: null, path: "clean-start", rebuild: null };
  }

  const previousSessionId = plan.previousSession?.sessionId;
  const previousCursor = plan.previousSession?.cursor ?? 0;
  const ownTranscript = previousSessionId ? sessionStore.load(previousSessionId) : null;
  const siblingTranscript = previousSessionId ? null : (input.siblingTranscript?.() ?? null);
  const source = ownTranscript ?? siblingTranscript;
  const session = createSession({
    projectPath: cwd,
    ...(previousSessionId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  });
  const imported = importMessages(
    session,
    plan.priorMessages,
    source ? contextAttachments(source) : [],
    source ? turnBoundaries(source) : [],
  );
  sessionStore.replace(session.sessionId, session.records);
  doppel.session = { sessionId: session.sessionId, cursor: plan.priorMessages.length };
  if (previousSessionId === undefined) {
    debug(
      `Case 2: doppel=${doppel.label} first turn with ${plan.priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`,
    );
  } else {
    const missedCount = plan.priorMessages.length - previousCursor;
    debug(
      `Case 4: doppel=${doppel.label} ${missedCount} missed messages, ${plan.priorMessages.length} total → replaced session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`,
    );
  }
  debug(
    `syncResult: path=rebuild doppel=${doppel.label} reason=${why} sessionId=${session.sessionId} priors=${plan.priorMessages.length} cursor=${previousCursor} ${previousSessionId === undefined ? "first" : "preserved"}`,
  );
  return {
    sessionId: session.sessionId,
    path: "rebuild",
    rebuild: {
      contextSource: ownTranscript ? "own" : siblingTranscript ? "sibling" : "none",
      ...imported,
      divergence: source ? transcriptDivergence(source, session.records) : null,
    },
  };
}

/** Claude Code keeps its injected context (environment, model, date, token budget, …) as
 *  attachment records after the message it rode in on, renders them back into that message on
 *  every request, and on resume injects whatever the transcript lacks at the new prompt. A rebuilt
 *  transcript without them gets that context at the tail instead, so the cached prefix breaks at
 *  message 0. Every attachment is carried rather than a known list, because which ones appear
 *  depends on the Claude Code version and endpoint: the first-party API adds a token-budget
 *  reminder on nearly every user turn that a custom base URL never sees. */
const UNRENDERED_ATTACHMENTS = new Set(["prompt_snapshot"]);

interface ContextPayload {
  type: string;
  [key: string]: unknown;
}

interface ContextAttachment {
  /** Which run of consecutive same-role messages the attachment followed. */
  group: number;
  attachment: ContextPayload;
}

function contextAttachments(entries: readonly SessionStoreEntry[]): ContextAttachment[] {
  const attachments: ContextAttachment[] = [];
  let group = -1;
  let role: string | null = null;
  for (const entry of entries) {
    if (entry.type === "user" || entry.type === "assistant") {
      if (entry.type !== role) group++;
      role = entry.type;
      continue;
    }
    if (entry.type !== "attachment" || group < 0) continue;
    // The store admits an attachment record only with a string type.
    const attachment = entry.attachment as ContextPayload;
    if (!UNRENDERED_ATTACHMENTS.has(attachment.type)) attachments.push({ group, attachment });
  }
  return attachments;
}

/** Where a rebuilt transcript stops rendering what the live one did. Claude Code renders each run
 *  of same-role records, with the context records that follow them, as one request message, so
 *  the first differing block is where a rebuild's cached prefix ends. Names only the block type
 *  and the fields that differ, never their content. */
export interface TranscriptDivergence {
  sourceGroups: number;
  rebuiltGroups: number;
  /** Role groups both transcripts render identically from the start. */
  matchedGroups: number;
  /** The first differing block; null when one transcript is a prefix of the other. */
  at: {
    role: string;
    block: number;
    sourceType: string | null;
    rebuiltType: string | null;
    /** Fields of that block whose values differ, when both sides have the same type. */
    fields: string[];
  } | null;
}

interface RenderedGroup {
  role: string;
  blocks: Array<Record<string, unknown>>;
}

function renderedGroups(entries: ReadonlyArray<{ type: string }>): RenderedGroup[] {
  const groups: RenderedGroup[] = [];
  for (const entry of entries) {
    if (entry.type === "user" || entry.type === "assistant") {
      if (groups.at(-1)?.role !== entry.type) groups.push({ role: entry.type, blocks: [] });
      const content = (entry as { message?: { content?: unknown } }).message?.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
      if (Array.isArray(blocks)) groups.at(-1)?.blocks.push(...blocks);
    } else if (entry.type === "attachment" && groups.length) {
      const attachment = (entry as { attachment?: ContextPayload }).attachment;
      if (attachment && !UNRENDERED_ATTACHMENTS.has(attachment.type))
        groups.at(-1)?.blocks.push({ ...attachment, type: `attachment:${attachment.type}` });
    }
  }
  return groups;
}

/** JSON with object keys sorted: key order does not reach the rendered request. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, field) =>
    field && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : field,
  );
}

function transcriptDivergence(
  source: ReadonlyArray<{ type: string }>,
  rebuilt: ReadonlyArray<{ type: string }>,
): TranscriptDivergence {
  const live = renderedGroups(source);
  const imported = renderedGroups(rebuilt);
  const counts = { sourceGroups: live.length, rebuiltGroups: imported.length };
  for (let group = 0; group < Math.min(live.length, imported.length); group++) {
    const left = live[group];
    const right = imported[group];
    for (let block = 0; block < Math.max(left.blocks.length, right.blocks.length); block++) {
      const a = left.blocks[block];
      const b = right.blocks[block];
      if (a && b && canonical(a) === canonical(b)) continue;
      const sameType = a !== undefined && b !== undefined && a.type === b.type;
      const fields = sameType
        ? [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
            (field) => canonical(a[field]) !== canonical(b[field]),
          )
        : [];
      const at = {
        role: left.role === right.role ? left.role : `${left.role}/${right.role}`,
        block,
        sourceType: typeof a?.type === "string" ? a.type : null,
        rebuiltType: typeof b?.type === "string" ? b.type : null,
        fields,
      };
      return { ...counts, matchedGroups: group, at };
    }
  }
  return { ...counts, matchedGroups: Math.min(live.length, imported.length), at: null };
}

/** The index of the last message in each run of consecutive same-role messages. */
function groupEnds(messages: ReadonlyArray<{ role: string }>): number[] {
  const ends: number[] = [];
  messages.forEach((message, index) => {
    if (index > 0 && message.role === messages[index - 1].role) ends[ends.length - 1] = index;
    else ends.push(index);
  });
  return ends;
}

/** Each context attachment after the last message of its role group in `messages`. */
function placeAttachments(
  messages: ReadonlyArray<{ role: string }>,
  attachments: readonly ContextAttachment[],
): ImportAttachment[] {
  const ends = groupEnds(messages);
  return attachments.flatMap(({ group, attachment }) =>
    group < ends.length ? [{ afterIndex: ends[group], attachment }] : [],
  );
}

/** Claude Code resumes a transcript that ends in a user message by writing a synthetic
 *  `No response requested.` turn before the new prompt. A query started on tool results the
 *  history already holds (a replay) therefore leaves that turn and the replay prompt between the
 *  results and the reply, in every live request after it. A rebuild without them matches the
 *  cached prefix only through the system prompt and tools. */
const SYNTHETIC_TURN = "No response requested.";

interface TurnBoundary {
  /** The role group of the synthetic assistant turn; the replay prompt is the next group. */
  group: number;
  /** Tool results in the user group the boundary follows. */
  results: number;
  prompt: string | ContentBlock[];
}

function turnBoundaries(entries: readonly SessionStoreEntry[]): TurnBoundary[] {
  const boundaries: TurnBoundary[] = [];
  /** Tool results per role group, counted the way `contextAttachments` numbers the groups. */
  const results: number[] = [];
  let role: string | null = null;
  let synthetic = -1;
  for (const entry of entries) {
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.type !== role) results.push(0);
    role = entry.type;
    const group = results.length - 1;
    const message = entry.message as { model?: string; content: string | ContentBlock[] };
    const content = message.content;
    if (entry.type === "user") {
      if (typeof content !== "string")
        results[group] += content.filter((block) => block.type === "tool_result").length;
      if (synthetic >= 0 && synthetic === group - 1)
        boundaries.push({ group: synthetic, results: results[synthetic - 1], prompt: content });
      synthetic = -1;
    } else {
      synthetic =
        message.model === "<synthetic>" &&
        Array.isArray(content) &&
        content.length === 1 &&
        content[0].type === "text" &&
        content[0].text === SYNTHETIC_TURN &&
        (results[group - 1] ?? 0) > 0
          ? group
          : -1;
    }
  }
  return boundaries;
}

/** Put each boundary back between the tool results it followed and the reply after them. A
 *  boundary is restored only where this history still has those results, alone in their user
 *  group and answered by an assistant turn; the first that does not line up ends the restoring,
 *  because every later group would be numbered one turn off. */
function restoreTurnBoundaries<M extends { role: string; content: string | ContentBlock[] }>(
  messages: M[],
  boundaries: readonly TurnBoundary[],
): { messages: M[]; restored: number } {
  const restored = [...messages];
  for (const [index, boundary] of boundaries.entries()) {
    const ends = groupEnds(restored);
    const resultsEnd = ends[boundary.group - 1];
    const resultsStart = boundary.group - 2 >= 0 ? ends[boundary.group - 2] + 1 : 0;
    const group = resultsEnd === undefined ? [] : restored.slice(resultsStart, resultsEnd + 1);
    const blocks = group.flatMap((message) =>
      typeof message.content === "string" ? [{ type: "text" }] : message.content,
    );
    const linesUp =
      group[0]?.role === "user" &&
      blocks.length === boundary.results &&
      blocks.every((block) => block.type === "tool_result") &&
      restored[resultsEnd + 1]?.role === "assistant";
    if (!linesUp) return { messages: restored, restored: index };
    restored.splice(
      resultsEnd + 1,
      0,
      { role: "assistant", content: [{ type: "text", text: SYNTHETIC_TURN }] } as M,
      { role: "user", content: boundary.prompt } as M,
    );
  }
  return { messages: restored, restored: boundaries.length };
}

/** Claude Code's test for an empty tool result, which it renders as a fixed sentence on the live
 *  MCP path. */
function isEmptyToolResult(block: ToolResultBlockParam): boolean {
  if (!block.content) return true;
  if (typeof block.content === "string") return block.content.trim() === "";
  return block.content.every((item) => item.type === "text" && item.text.trim() === "");
}

function toolResultIds(messages: ReadonlyArray<{ content: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const { content } of messages)
    if (Array.isArray(content))
      for (const block of content as Array<{ type: string; tool_use_id?: string }>)
        if (block.type === "tool_result" && block.tool_use_id) ids.add(block.tool_use_id);
  return ids;
}

/** Prepare Messages API history for Claude Code's session store. Native tool names
 * are already normalized at the frontend boundary; this layer sanitizes ids, repairs
 * pairing, and renders what Claude Code renders differently on the live path. */
function importMessages(
  session: Session,
  messages: MessageParam[],
  attachments: readonly ContextAttachment[],
  boundaries: readonly TurnBoundary[],
): ImportCompensations {
  const sanitizedIds = new Map<string, string>();
  const toolNames = new Map<string, string>();
  let emptyToolResults = 0;
  const anthropicMessages = messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((block) => {
      if (block.type === "tool_use") {
        toolNames.set(block.id, block.name);
        return { ...block, id: sanitizeToolId(block.id, sanitizedIds) };
      }
      if (block.type === "tool_result") {
        const tool_use_id = sanitizeToolId(block.tool_use_id, sanitizedIds);
        const name = toolNames.get(block.tool_use_id);
        if (!block.is_error && name && isEmptyToolResult(block)) {
          emptyToolResults++;
          return { ...block, tool_use_id, content: `(${name} completed with no output)` };
        }
        return { ...block, tool_use_id };
      }
      return block;
    });
    return { ...message, content };
  });

  debug(`importMessages: ${anthropicMessages.length} anthropic msgs`);
  debug(
    `importMessages: imported roles:`,
    anthropicMessages
      .map((m, i) => {
        const c = m.content;
        if (typeof c === "string") return `[${i}]${m.role}:text`;
        if (Array.isArray(c)) return `[${i}]${m.role}:${c.map((b) => b.type).join("+")}`;
        return `[${i}]${m.role}:?`;
      })
      .join(" "),
  );
  if (sanitizedIds.size > 0) {
    debug(
      `importMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds.entries()]
        .map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`))
        .join(", "),
    );
  }
  const bounded = restoreTurnBoundaries(
    anthropicMessages as Array<{
      role: "user" | "assistant";
      content: string | ContentBlock[];
    }>,
    boundaries,
  );
  if (boundaries.length)
    debug(
      `importMessages: restored ${bounded.restored} of ${boundaries.length} replay turn boundaries`,
    );
  // Repaired here to count what changed; importMessages also repairs internally (idempotent).
  const repaired = repairToolPairing(bounded.messages);
  if (repaired.length !== anthropicMessages.length) {
    debug(
      `importMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`,
    );
  }
  const importedResults = toolResultIds(anthropicMessages);
  const repairedResults = toolResultIds(repaired);
  const placed = placeAttachments(repaired, attachments);
  if (placed.length) debug(`importMessages: carried ${placed.length} context attachments`);
  if (repaired.length)
    session.importMessages(
      repaired as Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>,
      { attachments: placed },
    );
  return {
    contextAttachments: placed.length,
    emptyToolResults,
    sanitizedToolIds: [...sanitizedIds].filter(([original, clean]) => original !== clean).length,
    synthesizedToolResults: [...repairedResults].filter((id) => !importedResults.has(id)).length,
    droppedToolResults: [...importedResults].filter((id) => !repairedResults.has(id)).length,
    turnBoundaries: bounded.restored,
    skippedTurnBoundaries: boundaries.length - bounded.restored,
  };
}
