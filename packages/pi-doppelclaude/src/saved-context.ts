import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type CarriedContext, readCarriedContext } from "doppelclaude/carried-context";

/** Claude Code's context for this conversation, kept in the session so a rebuild after a restart
 *  renders the prefix Claude's earlier thinking is bound to. Pi never sends it to the model. */
export const CONTEXT_CUSTOM_TYPE = "pi-doppelclaude.context";

/** The context saved last on this branch, or null when it has none that is usable. */
export function savedContext(branch: readonly SessionEntry[]): CarriedContext | null {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === CONTEXT_CUSTOM_TYPE)
      return readCarriedContext(entry.data);
  }
  return null;
}
