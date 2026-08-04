import { join } from "node:path";
import {
  createAgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface NestedTask {
  result: Promise<string>;
}

async function createNestedModelRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });

  for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
    const provider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
    if (provider) {
      runtime.registerNativeProvider(provider);
      continue;
    }
    const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (config) runtime.registerProvider(providerId, config);
  }

  return runtime;
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant"
    )
      continue;
    if (!("content" in message) || !Array.isArray(message.content)) return "";
    return message.content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  return "";
}

async function runNestedAgent(prompt: string, ctx: ExtensionContext): Promise<string> {
  if (!ctx.model) throw new Error("NestedAgent requires an active model");

  const runtime = await createNestedModelRuntime(ctx);
  const model = runtime.getModel(ctx.model.provider, ctx.model.id);
  if (!model)
    throw new Error(`NestedAgent could not resolve ${ctx.model.provider}/${ctx.model.id}`);

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    modelRuntime: runtime,
    model,
    tools: [],
    sessionManager: SessionManager.inMemory(ctx.cwd),
  });

  try {
    await session.prompt(prompt);
    const text = lastAssistantText(session.messages);
    if (!text) throw new Error("NestedAgent completed without an assistant response");
    return text;
  } finally {
    session.dispose();
  }
}

export default function (pi: ExtensionAPI) {
  const tasks = new Map<string, NestedTask>();
  let nextTaskId = 0;

  const agentParameters = Type.Object({
    prompt: Type.String({ description: "Prompt for the nested agent" }),
    background: Type.Optional(
      Type.Boolean({ description: "Start the nested agent in the background" }),
    ),
  });
  pi.registerTool<typeof agentParameters>({
    name: "NestedAgent",
    label: "Nested agent",
    description:
      "Runs a prompt in a nested Pi ModelRuntime. Use this exactly when the user asks for NestedAgent.",
    parameters: agentParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = runNestedAgent(params.prompt, ctx);
      if (params.background) {
        const id = `nested-${++nextTaskId}`;
        tasks.set(id, { result });
        return { content: [{ type: "text", text: `Started ${id}` }], details: { id } };
      }
      return { content: [{ type: "text", text: await result }], details: {} };
    },
  });

  const resultParameters = Type.Object({
    id: Type.String({ description: "Nested task ID returned by NestedAgent" }),
  });
  pi.registerTool<typeof resultParameters>({
    name: "NestedAgentResult",
    label: "Nested agent result",
    description: "Waits for a background NestedAgent task and returns its response.",
    parameters: resultParameters,
    async execute(_toolCallId, params) {
      const task = tasks.get(params.id);
      if (!task) throw new Error(`Unknown nested task: ${params.id}`);
      try {
        return { content: [{ type: "text", text: await task.result }], details: {} };
      } finally {
        tasks.delete(params.id);
      }
    },
  });
}
