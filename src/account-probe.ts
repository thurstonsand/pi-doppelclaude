import {
  type AccountInfo,
  type ModelInfo,
  type Options,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { errorMessage } from "./errors.js";
import type { ProviderSettings } from "./settings.js";
import { parseValue } from "./validation.js";

const ACCOUNT_INFO_SCHEMA = Type.Object({
  email: Type.Optional(Type.String()),
  organization: Type.Optional(Type.String()),
  subscriptionType: Type.Optional(Type.String()),
  tokenSource: Type.Optional(Type.String()),
  apiKeySource: Type.Optional(Type.String()),
  apiProvider: Type.Optional(Type.String()),
});

const MODEL_INFO_SCHEMA = Type.Object({
  value: Type.String(),
  resolvedModel: Type.Optional(Type.String()),
  displayName: Type.String(),
  description: Type.String(),
});
const SUPPORTED_MODELS_SCHEMA = Type.Array(MODEL_INFO_SCHEMA);

interface AccountQuery {
  accountInfo(): Promise<AccountInfo>;
  supportedModels(): Promise<ModelInfo[]>;
  close(): void;
}

interface AccountProbeDependencies {
  providerSettings: ProviderSettings;
  queryFactory(request: { prompt: AsyncIterable<never>; options?: Options }): AccountQuery;
}

export interface AccountSnapshot {
  available: boolean;
  supportedModels: readonly ModelInfo[];
}

export type AccountProbe = () => Promise<AccountSnapshot>;

async function* noPrompt(): AsyncGenerator<never> {}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseAccountInfo(value: unknown): boolean {
  const account = parseValue(
    ACCOUNT_INFO_SCHEMA,
    value,
    "Claude Code returned malformed account information",
  );
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

function parseSupportedModels(value: unknown): ModelInfo[] {
  return parseValue(
    SUPPORTED_MODELS_SCHEMA,
    value,
    "Claude Code returned malformed supported-model information",
  );
}

export function createAccountProbe(dependencies: AccountProbeDependencies): AccountProbe {
  const { providerSettings, queryFactory } = dependencies;
  return async () => {
    let controlQuery: AccountQuery | undefined;
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;
      controlQuery = queryFactory({
        prompt: noPrompt(),
        options: {
          abortController,
          tools: [],
          settingSources: [],
          skills: [],
          persistSession: false,
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
        },
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("Claude Code account probe timed out after 15 seconds"));
        }, 15_000);
      });
      const [account, supportedModels] = await Promise.race([
        Promise.all([controlQuery.accountInfo(), controlQuery.supportedModels()]),
        deadline,
      ]);
      return {
        available: parseAccountInfo(account),
        supportedModels: parseSupportedModels(supportedModels),
      };
    } catch (error) {
      throw new Error(
        `Claude Code authentication check failed: ${errorMessage(error)}. Run \`claude auth login\` and try again.`,
        { cause: error },
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      controlQuery?.close();
    }
  };
}

export function createDefaultAccountProbe(providerSettings: ProviderSettings): AccountProbe {
  return createAccountProbe({ providerSettings, queryFactory: query });
}
