import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./convert.js";
import { applyLongContext, buildModels, type LongContextSettings } from "./models.js";
import { loadConfig } from "./config.js";
import { createBridgeRuntime } from "./bridge-runtime.js";
import { createCompaction } from "./compaction.js";
import { acquireBridgeOwner } from "./bridge-owner.js";
import { debug, errorMessage, moduleInstanceId } from "./debug.js";

// Project Pi's public Anthropic catalog down to bridge provider metadata.
const MODELS = buildModels(getBuiltinModels("anthropic"));

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	const providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models.
	// TODO(phase 2): derive plan and served context windows from live-query accountInfo/modelUsage.
	const longContextSettings: LongContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
	};

	// Compaction is isolated per activation and never touches the shared runtime
	// (it spawns a one-shot Claude Code query), so borrower activations run it too.
	const compaction = createCompaction({ longContextSettings });

	// One bridge runtime per process. The first activation builds and manages it;
	// a nested/subagent activation borrows it so its provider calls
	// route through the identical stream closure and reentrant QueryContexts.
	const { owner, ownsLifecycle, release } = acquireBridgeOwner(() => {
		const registeredModels = applyLongContext(MODELS, longContextSettings);
		const runtime = createBridgeRuntime({ providerSettings, longContextSettings });
		return { runtime, registeredModels };
	});
	const { runtime, registeredModels } = owner;
	debug(`owner: ${ownsLifecycle ? "created" : "borrowing"} shared bridge runtime (module=${moduleInstanceId})`);

	// Every activation registers the shared runtime's provider into its own Pi
	// runtime, by reference, so the stream closure identity is preserved for
	// nested/reentrant MCP routing.
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		streamSimple: runtime.stream,
	});

	// Compaction takeover runs per activation (root and borrower): each uses its
	// own config and the isolated summary never mutates shared runtime state.
	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
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

	// Only the activation that created the owner may mutate/close the shared
	// runtime or clear the owner. A borrower's lifecycle events must never clear the parent session,
	// overwrite its UI, mark its root session for rebuild, or close it on model
	// selection — so borrowers wire nothing below.
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
		if (event.previousModel?.baseUrl === "claude-bridge" && event.model.baseUrl !== "claude-bridge") {
			await runtime.closePersistent("provider switch");
		}
	});
	pi.on("session_compact", (event) => runtime.markRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", () => runtime.markRebuild("session_tree"));
}
