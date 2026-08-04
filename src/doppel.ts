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
import type { Context } from "@earendil-works/pi-ai";
import { createSession, repairToolPairing, type Session } from "cc-session-io";
import { convertPiMessages } from "./convert.js";
import { debug } from "./debug.js";
import { QueryContext } from "./query-state.js";
import type { BridgeSessionStore } from "./session-store.js";

export type DoppelKind = "host" | "guest" | "ephemeral";

export interface SessionState {
  sessionId: string;
  cursor: number;
  // Force the next sync down the REBUILD path when pi has mutated its messages
  // array out from under us (compact, tree navigation, or abort). REBUILD
  // atomically replaces the authoritative store transcript.
  needsRebuild?: boolean;
}

export type SyncPath = "reuse" | "rebuild" | "clean-start";

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
      priorMessages: Context["messages"];
      previousSession: SessionState;
      advanceCursor: boolean;
    }
  | {
      path: "rebuild" | "clean-start";
      priorMessages: Context["messages"];
      previousSession: SessionState | null;
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
  messages: Context["messages"],
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
  messages: Context["messages"],
  currentSession: SessionState | null,
): SyncPlan {
  return planFor(messages, currentSession);
}

function planFor(
  priorMessages: Context["messages"],
  currentSession: SessionState | null,
): SyncPlan {
  if (
    currentSession &&
    !currentSession.needsRebuild &&
    priorMessages.length >= currentSession.cursor
  ) {
    const missed = priorMessages.slice(currentSession.cursor);
    const trailingAssistantOnly =
      missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
    if (missed.length === 0 || trailingAssistantOnly) {
      return {
        path: "reuse",
        priorMessages,
        previousSession: currentSession,
        advanceCursor: trailingAssistantOnly,
      };
    }
  }
  return {
    path: priorMessages.length === 0 ? "clean-start" : "rebuild",
    priorMessages,
    previousSession: currentSession,
  };
}

/** Apply a plan to its doppel: the session it resumes from, and the transcript the store holds. */
export function applySessionSync(input: {
  doppel: Doppel;
  plan: SyncPlan;
  cwd: string;
  sessionStore: BridgeSessionStore;
  customToolNameToSdk?: Map<string, string>;
  modelId?: string;
}): SyncResult {
  const { doppel, plan, cwd, sessionStore, customToolNameToSdk, modelId } = input;
  if (plan.path === "reuse") {
    const previous = plan.previousSession;
    doppel.session = plan.advanceCursor
      ? { ...previous, cursor: plan.priorMessages.length }
      : previous;
    debug(
      `Case 3: ${plan.advanceCursor ? "advanced cursor past trailing assistant, " : ""}resuming session ${previous.sessionId.slice(0, 8)}, cursor=${doppel.session.cursor}`,
    );
    debug(
      `syncResult: path=reuse doppel=${doppel.label} sessionId=${previous.sessionId} cursor=${doppel.session.cursor}`,
    );
    return { sessionId: previous.sessionId, path: "reuse" };
  }
  if (plan.path === "clean-start") {
    debug(`Case 1: clean start, ${plan.priorMessages.length + 1} total messages`);
    debug(`syncResult: path=clean-start doppel=${doppel.label}`);
    return { sessionId: null, path: "clean-start" };
  }

  const previousSessionId = plan.previousSession?.sessionId;
  const previousCursor = plan.previousSession?.cursor ?? 0;
  const session = createSession({
    projectPath: cwd,
    ...(previousSessionId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  });
  importPiMessages(session, plan.priorMessages, customToolNameToSdk);
  sessionStore.replace(session.sessionId, session.records);
  doppel.session = { sessionId: session.sessionId, cursor: plan.priorMessages.length };
  if (previousSessionId === undefined) {
    debug(
      `Case 2: first turn with ${plan.priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`,
    );
  } else {
    const missedCount = plan.priorMessages.length - previousCursor;
    debug(
      `Case 4: ${missedCount} missed messages, ${plan.priorMessages.length} total → replaced session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`,
    );
  }
  debug(
    `syncResult: path=rebuild doppel=${doppel.label} sessionId=${session.sessionId} priors=${plan.priorMessages.length} ${previousSessionId === undefined ? "first" : "preserved"}`,
  );
  return { sessionId: session.sessionId, path: "rebuild" };
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: non-Anthropic thinking blocks are dropped (no valid signature), and only
// text/image/toolCall block types are handled. If all blocks in an assistant message
// are filtered, the message is dropped — which can create invalid sequences (e.g.
// two user messages in a row, or tool_result without preceding tool_use).
function importPiMessages(
  session: Session,
  messages: Context["messages"],
  customToolNameToSdk?: Map<string, string>,
): void {
  const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

  debug(
    `importPiMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`,
  );
  debug(
    `importPiMessages: imported roles:`,
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
      `importPiMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds.entries()]
        .map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`))
        .join(", "),
    );
  }
  // Pre-repair for debug logging; importMessages also repairs internally (idempotent).
  const repaired = repairToolPairing(anthropicMessages);
  if (repaired.length !== anthropicMessages.length) {
    debug(
      `importPiMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`,
    );
  }
  if (repaired.length) session.importMessages(repaired);
}
