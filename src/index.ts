import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDefaultAccountProbe } from "./account-probe.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import { acquireBridgeOwner } from "./bridge-owner.js";
import { createCompaction } from "./compaction.js";
import { configureDebug, debug, errorMessage, moduleInstanceId } from "./debug.js";
import { PROVIDER_ID } from "./models.js";
import { createAnthropicAgentSdkProvider, type AnthropicAgentSdkProvider } from "./provider.js";
import { loadBridgeSettings } from "./settings.js";

interface ActivationDependencies {
	initializeProvider: (provider: AnthropicAgentSdkProvider) => Promise<void>;
}

const defaultActivationDependencies: ActivationDependencies = {
	initializeProvider: (provider) => provider.initializeModels(),
};

export default function activate(
	pi: ExtensionAPI,
	dependencies: ActivationDependencies = defaultActivationDependencies,
): void {
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const settings = loadBridgeSettings(process.cwd());
	configureDebug(settings.debug);
	debug("loadSettings:", JSON.stringify(settings));
	const { provider: providerSettings } = settings;

	const compaction = createCompaction({
		queryFactory: query,
		loadProviderSettings: (cwd) => loadBridgeSettings(cwd).provider,
		loadRetryPolicy: (cwd, projectTrusted) =>
			SettingsManager.create(cwd, getAgentDir(), { projectTrusted }).getRetrySettings(),
	});

	const { owner, ownsLifecycle, release } = acquireBridgeOwner(() => {
		const runtime = createBridgeRuntime({ providerSettings });
		const provider = createAnthropicAgentSdkProvider({
			stream: runtime.stream,
			accountProbe: createDefaultAccountProbe(providerSettings),
		});
		return { runtime, provider };
	});
	const { runtime, provider } = owner;
	debug(`owner: ${ownsLifecycle ? "created" : "borrowing"} shared Provider/runtime (module=${moduleInstanceId})`);

	if (ownsLifecycle) {
		void dependencies.initializeProvider(provider).catch((error: unknown) => {
			debug("provider: initial model discovery failed; using available catalog state", error);
		});
	}
	pi.registerProvider(provider);

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
			debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
			ctx.ui?.notify?.(
				`Claude bridge compact failed (${msg}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
				"error",
			);
			return { cancel: true };
		}
	});

	if (!ownsLifecycle) return;

	pi.on("session_start", async (event, ctx) => {
		runtime.setUI(ctx.ui);
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			await runtime.clear(`session_start:${event.reason}`);
		}
	});
	pi.on("session_shutdown", async () => {
		await runtime.clear("session_shutdown");
		release();
	});
	pi.on("model_select", async (event) => {
		if (event.previousModel?.provider === PROVIDER_ID && event.model.provider !== PROVIDER_ID) {
			await runtime.closePersistent("provider switch");
		}
	});
	pi.on("session_compact", (event) => runtime.markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => runtime.markRebuild("session_tree"));
}
