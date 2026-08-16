import { query } from "@anthropic-ai/claude-agent-sdk";
import { type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createDefaultAccountProbe } from "./account-probe.js";
import { acquireBridgeOwner } from "./bridge-owner.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import { createCompaction } from "./compaction.js";
import { configureDebug, debug, moduleInstanceId } from "./debug.js";
import { createDefaultToolDescriptionCap } from "./description-cap.js";
import { errorMessage } from "./errors.js";
import { createBridgeModelCatalog } from "./model-catalog.js";
import { PROVIDER_ID } from "./models.js";
import { createAnthropicAgentSdkProvider } from "./provider.js";
import { REFUSAL_CUSTOM_TYPE, renderRefusalEntry } from "./refusal.js";
import { loadBridgeSettings } from "./settings.js";

export default function activate(pi: ExtensionAPI): void {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const settings = loadBridgeSettings(process.cwd());
  configureDebug(settings.debug);
  debug("loadSettings:", JSON.stringify(settings));
  const { provider: providerSettings } = settings;
  const toolDescriptionCap = createDefaultToolDescriptionCap(providerSettings);

  const compaction = createCompaction({
    queryFactory: query,
    loadProviderSettings: (cwd) => loadBridgeSettings(cwd).provider,
    loadRetryPolicy: (cwd, projectTrusted) =>
      SettingsManager.create(cwd, getAgentDir(), { projectTrusted }).getRetrySettings(),
  });

  const { owner, ownsLifecycle, release } = acquireBridgeOwner(() => {
    // The runtime teaches the catalog which models Claude actually serves and the provider
    // publishes them, so both sides of that exchange hold the same catalog.
    const modelCatalog = createBridgeModelCatalog();
    const runtime = createBridgeRuntime({
      providerSettings,
      modelCatalog,
      getToolDescriptionCap: toolDescriptionCap.get,
    });
    const provider = createAnthropicAgentSdkProvider({
      stream: runtime.stream,
      accountProbe: createDefaultAccountProbe(providerSettings),
      modelCatalog,
    });
    return { runtime, provider };
  });
  const { runtime, provider } = owner;
  debug(
    `owner: ${ownsLifecycle ? "created" : "borrowing"} shared Provider/runtime (module=${moduleInstanceId})`,
  );

  pi.registerProvider(provider);
  pi.registerEntryRenderer(REFUSAL_CUSTOM_TYPE, renderRefusalEntry);

  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return undefined;
    debug(
      `session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
        `isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
        `turnPrefix=${event.preparation.turnPrefixMessages.length}`,
    );
    try {
      const result = await compaction.run({
        preparation: event.preparation,
        model: ctx.model,
        branchEntries: event.branchEntries,
        customInstructions: event.customInstructions,
        signal: event.signal,
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
      });
      debug(`session_before_compact: takeover complete summaryLen=${result.summary.length}`);
      return { compaction: result };
    } catch (err) {
      const msg = errorMessage(err);
      debug(
        "session_before_compact: takeover failed; cancelling to avoid native compact fallback",
        err,
      );
      ctx.ui?.notify?.(
        `Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
        "error",
      );
      return { cancel: true };
    }
  });

  if (!ownsLifecycle) return;

  void toolDescriptionCap.start();

  pi.on("session_start", async (event, ctx) => {
    toolDescriptionCap.onSessionStart((message) => ctx.ui?.notify?.(message, "warning"));
    runtime.setHost({
      ui: ctx.ui,
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
    });
    await runtime.designateHost(ctx.sessionManager.getSessionId());
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      await runtime.clear(`session_start:${event.reason}`);
    }
  });
  pi.on("session_shutdown", async () => {
    toolDescriptionCap.onSessionShutdown();
    await runtime.clear("session_shutdown");
    release();
  });
  pi.on("model_select", async (event) => {
    if (event.previousModel?.provider === PROVIDER_ID && event.model.provider !== PROVIDER_ID) {
      await runtime.closePersistent("provider switch");
    }
  });
  pi.on("session_compact", async (event) => {
    await runtime.markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`);
  });
  pi.on("session_tree", async () => {
    await runtime.markRebuild("session_tree");
  });
}
