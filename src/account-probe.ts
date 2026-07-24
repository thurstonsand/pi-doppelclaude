import { query, type AccountInfo, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.js";
import { errorMessage } from "./debug.js";

interface AccountQuery {
	accountInfo(): Promise<AccountInfo>;
	close(): void;
}

interface AccountProbeDependencies {
	providerSettings: NonNullable<Config["provider"]>;
	queryFactory(request: { prompt: AsyncIterable<never>; options?: Options }): AccountQuery;
}

export type AccountProbe = () => Promise<boolean>;

async function* noPrompt(): AsyncGenerator<never> {}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseAccountInfo(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Claude Code returned malformed account information");
	}
	const account = value as AccountInfo;
	for (const field of ["email", "organization", "subscriptionType", "tokenSource", "apiKeySource", "apiProvider"] as const) {
		if (account[field] !== undefined && typeof account[field] !== "string") {
			throw new Error(`Claude Code returned malformed account information (${field})`);
		}
	}

	if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
		throw new Error(`Claude Code is using unsupported API provider "${account.apiProvider}"`);
	}

	const hasAccountIdentity = nonEmpty(account.email) || nonEmpty(account.subscriptionType);
	const hasCredentialSource =
		(nonEmpty(account.tokenSource) && account.tokenSource !== "none") ||
		(nonEmpty(account.apiKeySource) && account.apiKeySource !== "none");
	if (!hasAccountIdentity && !hasCredentialSource) return false;
	if (account.apiProvider === undefined) {
		throw new Error("Claude Code returned an authenticated account without an API provider");
	}
	return true;
}

export function createAccountProbe(dependencies: AccountProbeDependencies): AccountProbe {
	const { providerSettings, queryFactory } = dependencies;
	return async () => {
		let controlQuery: AccountQuery | undefined;
		try {
			const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
			controlQuery = queryFactory({
				prompt: noPrompt(),
				options: {
					tools: [],
					settingSources: [],
					skills: [],
					persistSession: false,
					...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				},
			});
			return parseAccountInfo(await controlQuery.accountInfo());
		} catch (error) {
			throw new Error(`Claude Code authentication check failed: ${errorMessage(error)}. Run \`claude auth login\` and try again.`, { cause: error });
		} finally {
			controlQuery?.close();
		}
	};
}

export function createDefaultAccountProbe(providerSettings: NonNullable<Config["provider"]>): AccountProbe {
	return createAccountProbe({ providerSettings, queryFactory: query });
}
