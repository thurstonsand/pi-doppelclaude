import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

interface StoredTranscript {
  entries: SessionStoreEntry[];
  mtime: number;
}

export interface SessionStoreWriter extends SessionStore {
  close(): void;
  invalidate(): void;
}

type TranscriptEntry = { type: string; uuid?: string; timestamp?: string };

export class MalformedSessionTranscriptError extends Error {}

function cloneEntries(entries: readonly TranscriptEntry[]): SessionStoreEntry[] {
  for (const [index, entry] of entries.entries()) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.type !== "string" ||
      entry.type.length === 0
    ) {
      throw new MalformedSessionTranscriptError(
        `Malformed SessionStore transcript entry at index ${index}: expected a nonempty string type`,
      );
    }
    if (entry.uuid !== undefined && typeof entry.uuid !== "string") {
      throw new MalformedSessionTranscriptError(
        `Malformed SessionStore transcript entry at index ${index}: uuid must be a string`,
      );
    }
    if (entry.timestamp !== undefined && typeof entry.timestamp !== "string") {
      throw new MalformedSessionTranscriptError(
        `Malformed SessionStore transcript entry at index ${index}: timestamp must be a string`,
      );
    }
  }
  return structuredClone([...entries]) as SessionStoreEntry[];
}

function transcriptKey(sessionId: string, subpath?: string): string {
  return `${sessionId}\0${subpath ?? ""}`;
}

export class BridgeSessionStore {
  private transcripts = new Map<string, StoredTranscript>();
  private revisions = new Map<string, number>();

  constructor(private readonly debug: (...args: unknown[]) => void = () => {}) {}

  createWriter(label: string): SessionStoreWriter {
    let open = true;
    const revisions = new Map<string, number>();
    const bindRevision = (sessionId: string): number => {
      const bound = revisions.get(sessionId);
      if (bound !== undefined) return bound;
      const current = this.revisions.get(sessionId) ?? 0;
      revisions.set(sessionId, current);
      return current;
    };

    const close = () => {
      if (!open) return;
      open = false;
      this.debug(`session-store: closed writer=${label}`);
    };
    const invalidate = () => {
      if (!open) return;
      open = false;
      for (const sessionId of revisions.keys()) {
        this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
      }
      this.debug(`session-store: invalidated writer=${label}`);
    };

    return {
      append: async (key, entries) => {
        const writerRevision = bindRevision(key.sessionId);
        const currentRevision = this.revisions.get(key.sessionId) ?? 0;
        if (!open || writerRevision !== currentRevision) {
          this.debug(
            `session-store: ignored stale append writer=${label} session=${key.sessionId.slice(0, 8)} entries=${entries.length}`,
          );
          return;
        }
        this.append(key, entries);
        this.debug(
          `session-store: append writer=${label} session=${key.sessionId.slice(0, 8)} subpath=${key.subpath ?? "main"} entries=${entries.length} total=${this.entryCount(key.sessionId, key.subpath)}`,
        );
      },
      load: async (key) => {
        bindRevision(key.sessionId);
        const entries = this.load(key.sessionId, key.subpath);
        this.debug(
          `session-store: load writer=${label} session=${key.sessionId.slice(0, 8)} subpath=${key.subpath ?? "main"} entries=${entries?.length ?? 0}`,
        );
        return entries;
      },
      listSessions: async () => this.listSessions(),
      delete: async (key) => this.delete(key.sessionId),
      listSubkeys: async (key) => this.listSubkeys(key.sessionId),
      close,
      invalidate,
    };
  }

  replace(sessionId: string, entries: readonly TranscriptEntry[]): void {
    const revision = (this.revisions.get(sessionId) ?? 0) + 1;
    this.revisions.set(sessionId, revision);
    for (const key of this.transcripts.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.transcripts.delete(key);
    }
    this.transcripts.set(transcriptKey(sessionId), {
      entries: cloneEntries(entries),
      mtime: Date.now(),
    });
    this.debug(
      `session-store: replace session=${sessionId.slice(0, 8)} revision=${revision} entries=${entries.length}`,
    );
  }

  delete(sessionId: string): void {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
    for (const key of this.transcripts.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.transcripts.delete(key);
    }
    this.debug(`session-store: delete session=${sessionId.slice(0, 8)}`);
  }

  clear(): void {
    this.transcripts.clear();
    this.revisions.clear();
  }

  load(sessionId: string, subpath?: string): SessionStoreEntry[] | null {
    const transcript = this.transcripts.get(transcriptKey(sessionId, subpath));
    return transcript ? cloneEntries(transcript.entries) : null;
  }

  entryCount(sessionId: string, subpath?: string): number {
    return this.transcripts.get(transcriptKey(sessionId, subpath))?.entries.length ?? 0;
  }

  private append(key: SessionKey, entries: SessionStoreEntry[]): void {
    const storageKey = transcriptKey(key.sessionId, key.subpath);
    const transcript = this.transcripts.get(storageKey) ?? { entries: [], mtime: 0 };
    const positionsByUuid = new Map<string, number>();
    for (let index = 0; index < transcript.entries.length; index++) {
      const uuid = transcript.entries[index].uuid;
      if (uuid) positionsByUuid.set(uuid, index);
    }
    for (const entry of cloneEntries(entries)) {
      const position = entry.uuid ? positionsByUuid.get(entry.uuid) : undefined;
      if (position === undefined) {
        if (entry.uuid) positionsByUuid.set(entry.uuid, transcript.entries.length);
        transcript.entries.push(entry);
      } else {
        transcript.entries[position] = entry;
      }
    }
    transcript.mtime = Date.now();
    this.transcripts.set(storageKey, transcript);
  }

  private listSessions(): Array<{ sessionId: string; mtime: number }> {
    const sessions: Array<{ sessionId: string; mtime: number }> = [];
    for (const [key, transcript] of this.transcripts) {
      const [sessionId, subpath] = key.split("\0");
      if (!subpath) sessions.push({ sessionId, mtime: transcript.mtime });
    }
    return sessions;
  }

  private listSubkeys(sessionId: string): string[] {
    const prefix = `${sessionId}\0`;
    return [...this.transcripts.keys()]
      .filter((key) => key.startsWith(prefix) && key.length > prefix.length)
      .map((key) => key.slice(prefix.length));
  }
}
