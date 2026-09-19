import {
  type AccountInfo,
  type ModelInfo,
  type Options,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "./errors.js";
import { sdkChildEnv } from "./sdk-child-env.js";

const ACCOUNT_INFO_SCHEMA = Type.Object({
  email: Type.Optional(Type.String()),
  organization: Type.Optional(Type.String()),
  subscriptionType: Type.Optional(Type.String()),
  tokenSource: Type.Optional(Type.String()),
  apiKeySource: Type.Optional(Type.String()),
  apiProvider: Type.Optional(Type.String()),
});

// Parsing cleans unknown keys, so anything the catalog synthesizes a model from has to be named
// here or it never survives the probe.
const MODEL_INFO_SCHEMA = Type.Object({
  value: Type.String(),
  resolvedModel: Type.Optional(Type.String()),
  displayName: Type.String(),
  description: Type.String(),
  supportedEffortLevels: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
        Type.Literal("xhigh"),
        Type.Literal("max"),
      ]),
    ),
  ),
  supportsAdaptiveThinking: Type.Optional(Type.Boolean()),
});
const SUPPORTED_MODELS_SCHEMA = Type.Array(MODEL_INFO_SCHEMA);

interface AccountQuery {
  accountInfo(): Promise<AccountInfo>;
  supportedModels(): Promise<ModelInfo[]>;
  close(): void;
}

export interface AccountProbeDependencies {
  pathToClaudeCodeExecutable?: string;
  queryFactory(request: { prompt: AsyncIterable<never>; options?: Options }): AccountQuery;
}

export interface AccountSnapshot {
  available: boolean;
  supportedModels: readonly ModelInfo[];
}

export type AccountProbe = (signal?: AbortSignal) => Promise<AccountSnapshot>;

async function* noPrompt(): AsyncGenerator<never> {}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseValue<T>(schema: TSchema, value: unknown, message: string): T {
  try {
    return Value.Parse(schema, value) as T;
  } catch (cause) {
    const error = Value.Errors(schema, value)[0];
    const detail = error ? `: ${error.instancePath || "/"} ${error.message}` : "";
    throw new Error(`${message}${detail}`, { cause });
  }
}

function parseAccountInfo(value: unknown): boolean {
  const account = parseValue<AccountInfo>(
    ACCOUNT_INFO_SCHEMA,
    value,
    "Claude Code returned malformed account information",
  );
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") {
    throw new Error(`Claude Code is using unsupported API provider "${account.apiProvider}"`);
  }

  if (nonEmpty(account.apiKeySource) && account.apiKeySource !== "none") {
    throw new Error("Claude Code is authenticated with an API key instead of a subscription");
  }

  const hasAccountIdentity = nonEmpty(account.email) || nonEmpty(account.subscriptionType);
  const hasCredentialSource = nonEmpty(account.tokenSource) && account.tokenSource !== "none";
  if (!hasAccountIdentity && !hasCredentialSource) return false;
  if (account.apiProvider === undefined) {
    throw new Error("Claude Code returned an authenticated account without an API provider");
  }
  return true;
}

function parseSupportedModels(value: unknown): ModelInfo[] {
  return parseValue<ModelInfo[]>(
    SUPPORTED_MODELS_SCHEMA,
    value,
    "Claude Code returned malformed supported-model information",
  );
}

export function createAccountProbe(dependencies: AccountProbeDependencies): AccountProbe {
  const { pathToClaudeCodeExecutable, queryFactory } = dependencies;
  return async (signal?: AbortSignal) => {
    let controlQuery: AccountQuery | undefined;
    const abortController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => abortController.abort(signal?.reason);
    let rejectCancellation: (() => void) | undefined;
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      controlQuery = queryFactory({
        prompt: noPrompt(),
        options: {
          abortController,
          env: sdkChildEnv(),
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          skills: [],
          persistSession: false,
          ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
        },
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error("Claude Code account probe timed out after 15 seconds"));
        }, 15_000);
      });
      const cancelled = new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason ?? new Error("Account probe aborted"));
        else {
          rejectCancellation = () => reject(signal?.reason ?? new Error("Account probe aborted"));
          signal?.addEventListener("abort", rejectCancellation, { once: true });
        }
      });
      const [account, supportedModels] = await Promise.race([
        Promise.all([controlQuery.accountInfo(), controlQuery.supportedModels()]),
        deadline,
        cancelled,
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
      signal?.removeEventListener("abort", abort);
      if (rejectCancellation) signal?.removeEventListener("abort", rejectCancellation);
      abortController.abort();
      controlQuery?.close();
    }
  };
}

export function createDefaultAccountProbe(pathToClaudeCodeExecutable?: string): AccountProbe {
  return createAccountProbe({ pathToClaudeCodeExecutable, queryFactory: query });
}
