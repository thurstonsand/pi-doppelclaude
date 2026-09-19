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
import type { MessageParam } from "@anthropic-ai/sdk/resources";
import { type ContentBlock, createSession, repairToolPairing, type Session } from "cc-session-io";
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
    return { sessionId: previous.sessionId, path: "reuse" };
  }
  if (plan.path === "clean-start") {
    debug(
      `Case 1: doppel=${doppel.label} clean start, ${plan.priorMessages.length + 1} total messages`,
    );
    debug(`syncResult: path=clean-start doppel=${doppel.label} reason=${why}`);
    return { sessionId: null, path: "clean-start" };
  }

  const previousSessionId = plan.previousSession?.sessionId;
  const previousCursor = plan.previousSession?.cursor ?? 0;
  const session = createSession({
    projectPath: cwd,
    ...(previousSessionId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  });
  importMessages(session, plan.priorMessages);
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
  return { sessionId: session.sessionId, path: "rebuild" };
}

/** Prepare Messages API history for Claude Code's session store. Native tool names
 * are already normalized at the frontend boundary; this layer only sanitizes ids
 * and repairs pairing. */
function importMessages(session: Session, messages: MessageParam[]): void {
  const sanitizedIds = new Map<string, string>();
  const anthropicMessages = messages.map((message) => {
    if (typeof message.content === "string") return message;
    const content = message.content.map((block) => {
      if (block.type === "tool_use") {
        return { ...block, id: sanitizeToolId(block.id, sanitizedIds) };
      }
      if (block.type === "tool_result") {
        return { ...block, tool_use_id: sanitizeToolId(block.tool_use_id, sanitizedIds) };
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
  // Pre-repair for debug logging; importMessages also repairs internally (idempotent).
  const repaired = repairToolPairing(
    anthropicMessages as Array<{
      role: "user" | "assistant";
      content: string | ContentBlock[];
    }>,
  );
  if (repaired.length !== anthropicMessages.length) {
    debug(
      `importMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`,
    );
  }
  if (repaired.length)
    session.importMessages(
      repaired as Array<{ role: "user" | "assistant"; content: string | ContentBlock[] }>,
    );
}
