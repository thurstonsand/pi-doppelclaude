import type { Api, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { QueryContext } from "doppelclaude/query-state";
import { createPiResponseRuntime } from "pi-doppelclaude/pi-response";

/** Opens the same native-response → Pi projection used by the provider runtime. */
export function beginProjectedCommand(
  c: QueryContext,
  model: Model<Api>,
): AssistantMessageEventStream {
  const projection = createPiResponseRuntime();
  const { native, stream } = projection.adapt(model);
  c.observeCommandUsage = (observation) => projection.observeUsage(observation, model);
  c.beginCommand(model.id, native);
  return stream;
}
