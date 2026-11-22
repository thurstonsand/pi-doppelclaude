// Carried context: what Claude Code writes into a conversation's transcript that the client's
// history does not hold, kept word for word so a rebuild in another process renders the prefix
// Claude Code sent live. Claude's thinking is bound to that prefix, so a rebuild without it loses
// every earlier thinking block (diag/THINKING-BINDING.md).

import type { ContentBlock } from "cc-session-io";
import { Type } from "typebox";
import { Value } from "typebox/value";

export interface ContextPayload {
  type: string;
  [key: string]: unknown;
}

/** A context record (environment, model, date, …) and the run of same-role messages it followed. */
export interface ContextAttachment {
  group: number;
  attachment: ContextPayload;
}

/** Claude Code's synthetic turn after replayed tool results, and the replay prompt after it. */
export interface TurnBoundary {
  /** The role group of the synthetic assistant turn; the replay prompt is the next group. */
  group: number;
  /** Tool results in the user group the boundary follows. */
  results: number;
  prompt: string | ContentBlock[];
}

export interface CarriedContext {
  attachments: ContextAttachment[];
  boundaries: TurnBoundary[];
}

const Group = Type.Integer({ minimum: 0 });
// Checked rather than parsed: parsing strips unknown keys, and the records must stay verbatim.
const CARRIED_CONTEXT_SCHEMA = Type.Object({
  attachments: Type.Array(
    Type.Object({ group: Group, attachment: Type.Object({ type: Type.String() }) }),
  ),
  boundaries: Type.Array(
    Type.Object({
      group: Group,
      results: Type.Integer({ minimum: 0 }),
      prompt: Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String() }))]),
    }),
  ),
});

/** Saved context read back from outside the process. Anything that does not match is unusable,
 *  and the rebuild falls back to rendering without it. */
export function readCarriedContext(value: unknown): CarriedContext | null {
  return Value.Check(CARRIED_CONTEXT_SCHEMA, value) ? (value as CarriedContext) : null;
}
