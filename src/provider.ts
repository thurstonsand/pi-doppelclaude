import {
	lazyStream,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { AccountProbe } from "./account-probe.js";
import {
	buildModels,
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
}

const THINKING_LEVELS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);

function compatibleReasoning(reasoning: unknown): ThinkingLevel | undefined {
	return typeof reasoning === "string" && THINKING_LEVELS.has(reasoning) ? reasoning as ThinkingLevel : undefined;
}

export function createAnthropicAgentSdkProvider(dependencies: ProviderDependencies): Provider<typeof PROVIDER_API> {
	const models = buildModels(getBuiltinModels("anthropic"));
	let successfulAccountSnapshot = false;
	let inFlightProbe: Promise<boolean> | undefined;

	const probe = (): Promise<boolean> => {
		if (inFlightProbe) return inFlightProbe;
		inFlightProbe = dependencies.accountProbe().finally(() => {
			inFlightProbe = undefined;
		});
		return inFlightProbe;
	};

	const check = async () => {
		const available = await probe();
		successfulAccountSnapshot = available;
		return available ? { type: "api_key" as const, source: "Claude Code" } : undefined;
	};

	const resolve = async () => {
		if (!successfulAccountSnapshot) {
			const available = await probe();
			successfulAccountSnapshot = available;
			if (!available) return undefined;
		}
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
		getModels: () => models,
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
