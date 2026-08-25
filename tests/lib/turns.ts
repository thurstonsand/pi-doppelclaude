// Synchronizing a test with the turn it is driving, rather than with the clock.
//
// A recorded stream hands back the handle to its own consumption, so a test awaits the
// end of the turn it is asserting on. State no terminal event announces — a query
// spawned, a message buffered, a prompt delivered — is waited for by naming the
// condition. The alternative these tests used to run on was sleeping for a guessed 50ms
// and asserting on whatever had arrived by then, which passes almost always.

import assert from "node:assert/strict";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

export interface RecordedTurn {
  /** Everything the turn has streamed so far. */
  events: AssistantMessageEvent[];
  /** Settles when the stream ends; awaiting it is what makes "the turn is over" a fact. */
  done: Promise<void>;
}

export function record(source: AsyncIterable<AssistantMessageEvent>): RecordedTurn {
  const events: AssistantMessageEvent[] = [];
  const done = (async () => {
    for await (const event of source) events.push(event);
  })();
  return { events, done };
}

/** Waits for a state the runtime is expected to reach. A timeout names what never
 *  happened, instead of leaving the next assertion to report the symptom. */
export async function until(reached: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!reached()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
