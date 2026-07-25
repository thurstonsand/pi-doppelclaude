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

export interface AnthropicAgentSdkProvider extends Provider<typeof PROVIDER_API> {
	initializeModels(): Promise<void>;
}

const THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

function compatibleReasoning(reasoning: unknown): ThinkingLevel | undefined {
	return typeof reasoning === "string" && THINKING_LEVELS.has(reasoning) ? reasoning as ThinkingLevel : undefined;
}

export function createAnthropicAgentSdkProvider(dependencies: ProviderDependencies): AnthropicAgentSdkProvider {
	const catalog = dependencies.modelCatalog ?? createBridgeModelCatalog();
	let lastSnapshot: AccountSnapshot | undefined;
	let lastProbe: Promise<AccountSnapshot> | undefined;
	let inFlightProbe: Promise<AccountSnapshot> | undefined;

	const launchProbe = (): Promise<AccountSnapshot> => {
		const tracked = dependencies.accountProbe().then((snapshot) => {
			lastSnapshot = snapshot;
			return snapshot;
		}).finally(() => {
			if (inFlightProbe === tracked) inFlightProbe = undefined;
		});
		lastProbe = tracked;
		inFlightProbe = tracked;
		void tracked.catch(() => {});
		return tracked;
	};

	const startProbe = (fresh: boolean): Promise<AccountSnapshot> =>
		inFlightProbe ?? (!fresh ? lastProbe : undefined) ?? launchProbe();

	const check = async () => {
		const unavailable = lastSnapshot?.available === false;
		void startProbe(true);
		return unavailable ? undefined : { type: "api_key" as const, source: "Claude Code" };
	};

	const resolve = async () => {
		const snapshot = await startProbe(false);
		if (!snapshot.available) return undefined;
		return { auth: {}, source: "Claude Code" };
	};

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
		async initializeModels() {
			const snapshot = await startProbe(false);
			await catalog.initialize(snapshot.supportedModels);
		},
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
			const snapshot = context.allowNetwork ? await startProbe(true) : undefined;
			await catalog.refresh(context, snapshot?.supportedModels ?? []);
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
