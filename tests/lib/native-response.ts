import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { CoreResponseEvent } from "doppelclaude/core-response";
import type { QueryContext } from "doppelclaude/query-state";
import { createPiResponseRuntime } from "pi-doppelclaude/pi-response";

/**
 * Opens the same native-response → Pi projection used by the provider runtime. `seen`, when
 * given, collects the native events too: what the HTTP frontend would serve.
 */
export function beginProjectedCommand(
  c: QueryContext,
  model: Model<Api>,
  seen?: CoreResponseEvent[],
): AssistantMessageEventStream {
  const projection = createPiResponseRuntime();
  const { native, stream } = projection.adapt(model);
  c.observeCommandUsage = (observation) => projection.observeUsage(observation, model);
  c.beginCommand(
    model.id,
    seen
      ? {
          push(event) {
            seen.push(structuredClone(event));
            native.push(event);
          },
          end: () => native.end(),
          [Symbol.asyncIterator]: () => native[Symbol.asyncIterator](),
        }
      : native,
  );
  return stream;
}
