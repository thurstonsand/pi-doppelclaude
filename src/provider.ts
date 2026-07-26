import {
	lazyStream,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AccountProbe, AccountSnapshot } from "./account-probe.js";
import { createBridgeModelCatalog, type BridgeModelCatalog } from "./model-catalog.js";
import {
	type BridgeModel,
	isSupportedModel,
	PROVIDER_API,
	PROVIDER_BASE_URL,
	PROVIDER_ID,
	PROVIDER_NAME,
	unsupportedModelMessage,
} from "./models.js";

interface ProviderDependencies {
	stream(model: BridgeModel, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	accountProbe: AccountProbe;
	modelCatalog?: BridgeModelCatalog;
}

const THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

function compatibleReasoning(reasoning: unknown): ThinkingLevel | undefined {
	return typeof reasoning === "string" && THINKING_LEVELS.has(reasoning) ? reasoning as ThinkingLevel : undefined;
}

export function createAnthropicAgentSdkProvider(dependencies: ProviderDependencies): Provider<typeof PROVIDER_API> {
	const catalog = dependencies.modelCatalog ?? createBridgeModelCatalog();
	let lastSnapshot: AccountSnapshot | undefined;
	let inFlightProbe: Promise<AccountSnapshot> | undefined;

	// Asking Claude Code what it serves costs a full CLI boot, so the probe runs only when the
	// catalog asks for it. Every other path replays the catalog Pi already persisted.
	const probeAccount = (): Promise<AccountSnapshot> => {
		const tracked = inFlightProbe ?? dependencies.accountProbe().then((snapshot) => {
			lastSnapshot = snapshot;
			return snapshot;
		}).finally(() => {
			if (inFlightProbe === tracked) inFlightProbe = undefined;
		});
		inFlightProbe = tracked;
		return tracked;
	};

	// Claude Code authenticates its own subprocess, so the bridge holds no credential to validate.
	// Ambient auth stands until a completed probe reports the account logged out.
	const authenticated = () => lastSnapshot?.available !== false;
	const check = async () => authenticated() ? { type: "api_key" as const, source: "Claude Code" } : undefined;
	const resolve = async () => authenticated() ? { auth: {}, source: "Claude Code" } : undefined;

	const validatedStream = (
		model: Model<any>,
		context: Context,
		options: SimpleStreamOptions | undefined,
	): AssistantMessageEventStream => {
		if (!isSupportedModel(model)) {
			return lazyStream(model, async () => {
				throw new Error(unsupportedModelMessage(model));
			});
		}
		return dependencies.stream(model, context, options);
	};

	return {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		baseUrl: PROVIDER_BASE_URL,
		auth: {
			apiKey: {
				name: "Claude Code CLI authentication — run `claude auth login`",
				check,
				resolve,
			},
		},
		getModels: catalog.getModels,
		async refreshModels(context) {
			await catalog.refresh(context, async () => (await probeAccount()).supportedModels);
		},
		filterModels: (candidates) => candidates.filter(isSupportedModel),
		stream(model, context, options) {
			const { reasoning, ...baseOptions } = (options ?? {}) as SimpleStreamOptions & Record<string, unknown>;
			const normalizedOptions: SimpleStreamOptions = baseOptions;
			normalizedOptions.reasoning = compatibleReasoning(reasoning);
			return validatedStream(model, context, normalizedOptions);
		},
		streamSimple: validatedStream,
	};
}
