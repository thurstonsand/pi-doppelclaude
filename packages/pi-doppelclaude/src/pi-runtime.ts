import type { Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime } from "doppelclaude/bridge-runtime";
import type { RefusalEntryData } from "doppelclaude/refusal-data";
import type { BridgeSessionStore } from "doppelclaude/session-store";
import { convertPiMessages, readPiTranscript } from "./convert.js";
import type { BridgeModelCatalog } from "./model-catalog.js";
import { createPiResponseRuntime } from "./pi-response.js";
import type { ProviderSettings } from "./settings.js";
import { planTurn, resolveMcpTools } from "./turn-plan.js";

export interface PiBridgeRuntimeDependencies {
  providerSettings: ProviderSettings;
  queryFactory?(request: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): Query;
  sessionStore?: BridgeSessionStore;
  modelCatalog?: BridgeModelCatalog;
  getToolDescriptionCap?(): number | false;
}

export interface BridgeHost {
  ui: ExtensionUIContext;
  appendEntry(customType: string, data: RefusalEntryData): void;
}

/** Pi-only adapter. Conversion, provider settings, model metadata, and response accounting stop here. */
export function createPiBridgeRuntime(dependencies: PiBridgeRuntimeDependencies) {
  let host: BridgeHost | null = null;
  const responses = createPiResponseRuntime();
  const models = new Map<string, Model<Api>>();
  const core = createBridgeRuntime({
    queryFactory: dependencies.queryFactory,
    sessionStore: dependencies.sessionStore,
    notify: (message, level) => host?.ui.notify(message, level),
    refusal: (customType, data) => host?.appendEntry(customType, data),
    observeServedModel: (id) => dependencies.modelCatalog?.noteServedModel(id),
    observeCommandUsage: (usage) => {
      const model = models.get(usage.requestedModel);
      if (model) responses.observeUsage(usage, model);
    },
  });

  function stream(
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
    explicitReplay = false,
  ): AssistantMessageEventStream {
    models.set(model.id, model);
    const transcript = readPiTranscript(context);
    const toolCap = dependencies.getToolDescriptionCap?.() ?? false;
    const turnTools = resolveMcpTools(transcript.tools, toolCap, options?.toolChoice);
    const nativeMessages = convertPiMessages(transcript.messages, turnTools.customToolNameToSdk)
      .anthropicMessages as import("@anthropic-ai/sdk/resources/messages/messages").MessageParam[];
    const persistent = Boolean(options?.sessionId);
    const plan = planTurn({
      model,
      piSystemMessage: transcript.systemMessage,
      options,
      providerSettings: dependencies.providerSettings,
      oneShot: !persistent,
      relocations: turnTools.relocations,
    });
    const {
      cwd,
      model: sdkModel,
      systemPrompt,
      effort,
      mcpServers: _mcp,
      ...spawnOptions
    } = plan.queryOptions;
    const request = {
      conversationKey: options?.sessionId,
      ephemeral: !options?.sessionId,
      model: model.id,
      sdkModel,
      messages: nativeMessages,
      tools: turnTools.mcpTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters as { type: "object" },
      })),
      systemPrompt,
      effort,
      signal: options?.signal,
      cwd: cwd ?? process.cwd(),
      options: spawnOptions,
      toolNameToSdk: turnTools.customToolNameToSdk,
      toolNameToClient: turnTools.customToolNameToPi,
    };
    const adapter = responses.adapt(model);
    const native = explicitReplay ? core.replay(request) : core.turn(request);
    void (async () => {
      for await (const event of native) adapter.native.push(event);
      adapter.native.end();
    })();
    return adapter.stream;
  }

  return {
    stream: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
      stream(model, context, options),
    replay: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
      stream(model, context, options, true),
    setHost(next: BridgeHost | null) {
      host = next;
    },
    clear: core.clear,
    closePersistent: core.closePersistent,
    markRebuild: core.markRebuild,
    designateHost: core.designateHost,
    test: core.test,
  };
}
