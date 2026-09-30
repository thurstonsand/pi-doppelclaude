import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { MessageParam, Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RuntimeRequest } from "doppelclaude/runtime-request";
import { Type } from "typebox";
import { parseValue } from "./validation.js";

/** A turn in the Messages API shape that pi's `before_provider_request` handlers see. */
export interface ProviderPayload {
  model: string;
  system: Options["systemPrompt"];
  messages: MessageParam[];
  tools: Tool[];
}

const PAYLOAD_SCHEMA = Type.Object(
  {
    model: Type.String(),
    system: Type.Unknown(),
    messages: Type.Array(
      Type.Object({
        role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
        content: Type.Union([Type.String(), Type.Array(Type.Object({ type: Type.String() }))]),
      }),
    ),
    tools: Type.Array(
      Type.Object({
        name: Type.String(),
        description: Type.Optional(Type.String()),
        input_schema: Type.Object({ type: Type.Literal("object") }),
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * Offers the turn to pi's payload hook and takes back what the bridge can honour: the newest
 * message, and a subset of the declared tools. Session sync compares only message counts, so
 * rewriting history Claude Code has already seen would go unnoticed. The model belongs to
 * Claude Code, and the system prompt has already been rewritten to stay deliverable. Changing
 * any of those, or adding a Messages API field the bridge cannot forward, fails the turn.
 * Tool names in messages carry Claude Code's MCP prefix; names in tools are pi's.
 */
export async function applyPayloadHook(
  request: RuntimeRequest,
  model: Model<Api>,
  onPayload: ((payload: unknown, model: Model<Api>) => unknown) | undefined,
): Promise<RuntimeRequest> {
  if (!onPayload) return request;
  const payload: ProviderPayload = {
    model: request.sdkModel ?? request.model,
    system: request.systemPrompt,
    messages: request.messages,
    tools: request.tools ?? [],
  };
  const offered = structuredClone(payload);
  const next = parseValue(
    PAYLOAD_SCHEMA,
    (await onPayload(offered, model)) ?? offered,
    "doppelclaude: invalid provider payload",
  );
  if (next.model !== payload.model)
    throw new Error("doppelclaude: a provider payload hook cannot change the model");
  if (JSON.stringify(next.system) !== JSON.stringify(payload.system))
    throw new Error("doppelclaude: a provider payload hook cannot change the system prompt");
  if (JSON.stringify(next.messages.slice(0, -1)) !== JSON.stringify(payload.messages.slice(0, -1)))
    throw new Error("doppelclaude: a provider payload hook can only rewrite the newest message");
  const declared = new Set(payload.tools.map((tool) => tool.name));
  const undeclared = next.tools.find((tool) => !declared.has(tool.name));
  if (undeclared)
    throw new Error(
      `doppelclaude: a provider payload hook added undeclared tool ${undeclared.name}`,
    );
  return {
    ...request,
    messages: next.messages as MessageParam[],
    tools: next.tools as Tool[],
  };
}
