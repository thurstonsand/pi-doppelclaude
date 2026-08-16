// Compaction: isolated summary generation and prior-compaction file-op reinjection.
//
// When pi asks a Doppelclaude model to compact, the bridge takes over: it runs
// the split-turn summary as an isolated Claude Code subprocess (never through the
// live provider stream — see issue #18) and carries forward file operations from
// the previous compaction so <read-files>/<modified-files> stay accurate.

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type RetryPolicy,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  type CompactionEntry,
  type CompactionResult,
  compact,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { messageContentToText } from "./convert.js";
import { debug, makeCliDebugOptions } from "./debug.js";
import { errorMessage } from "./errors.js";
import { claudeCodeModelId } from "./models.js";
import { sdkChildEnv } from "./sdk-child-env.js";
import { logServedContextWindow, resultErrorText } from "./sdk-result.js";
import { applySdkUsage, debugSdkUsage, type SdkUsage } from "./sdk-usage.js";
import type { ProviderSettings } from "./settings.js";
import { buildClaudeSystemPrompt, settingSourcesFor } from "./system-prompt.js";

interface IsolatedQuery extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  close(): void;
}

interface CompactionDependencies {
  queryFactory(request: { prompt: string; options?: Options }): IsolatedQuery;
  loadProviderSettings(cwd: string): ProviderSettings;
  loadRetryPolicy(cwd: string, projectTrusted: boolean): RetryPolicy;
}

function newAssistantOutput(
  model: Model<Api>,
  text: string,
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
  if (messages.length !== 1 || messages[0].role !== "user") {
    throw new Error(
      `isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
        `(${messages.map((m) => m.role).join(",")})`,
    );
  }
  const last = messages[0];
  const promptText =
    typeof last.content === "string" ? last.content : messageContentToText(last.content) || "";
  if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
  return promptText;
}

function reinjectPriorCompactionFileOps(
  branchEntries: Array<{ type: string; details?: unknown }>,
  preparation: { fileOps: { read: Set<string>; edited: Set<string> } },
): void {
  const prior = [...branchEntries]
    .reverse()
    .find((entry): entry is CompactionEntry => entry.type === "compaction");
  const details = prior?.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
  if (!Array.isArray(details?.readFiles) || !Array.isArray(details?.modifiedFiles)) return;
  for (const file of details.readFiles) preparation.fileOps.read.add(String(file));
  for (const file of details.modifiedFiles) preparation.fileOps.edited.add(String(file));
  debug(
    `compact takeover: re-injected prior file ops read=${details.readFiles.length} modified=${details.modifiedFiles.length}`,
  );
}

interface CompactionRequest {
  preparation: SessionBeforeCompactEvent["preparation"];
  model: Model<Api>;
  branchEntries: Array<{ type: string; details?: unknown }>;
  customInstructions: string | undefined;
  signal: AbortSignal | undefined;
  cwd: string;
  projectTrusted: boolean;
}

export function createCompaction(dependencies: CompactionDependencies) {
  const { queryFactory, loadProviderSettings, loadRetryPolicy } = dependencies;

  async function runIsolatedSummary(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
    cwd: string,
  ): Promise<void> {
    let sdkQuery: IsolatedQuery | undefined;
    let wasAborted = false;
    const onAbort = () => {
      wasAborted = true;
      void sdkQuery?.interrupt().catch(() => {});
      try {
        sdkQuery?.close();
      } catch {}
    };

    try {
      const promptText = extractIsolatedSummaryPrompt(context.messages);
      const compactProviderSettings = loadProviderSettings(cwd);
      const compactSystemPromptMode = compactProviderSettings.systemPromptMode;
      const compactSettingSources = settingSourcesFor(compactSystemPromptMode);
      const claudeExecutable = compactProviderSettings.pathToClaudeCodeExecutable;
      const cliModel = claudeCodeModelId(model);
      debug(
        `compact summary: spawn model=${cliModel} registeredModel=${model.id} promptLen=${promptText.length}`,
      );

      sdkQuery = queryFactory({
        prompt: promptText,
        options: {
          cwd,
          env: sdkChildEnv({ DISABLE_AUTO_COMPACT: "1" }),
          tools: [],
          strictMcpConfig: true,
          ...(compactSettingSources ? { settingSources: compactSettingSources } : {}),
          skills: [],
          persistSession: false,
          systemPrompt: buildClaudeSystemPrompt(
            context.systemPrompt,
            compactSystemPromptMode,
            compactProviderSettings.systemPromptReplacements,
          ),
          model: cliModel,
          maxTurns: 1,
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
          ...makeCliDebugOptions("compact-summary"),
        },
      });

      if (options?.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }

      let assistantText = "";
      let finalText = "";
      let errorText: string | undefined;
      let terminalUsage: SdkUsage | undefined;
      let firstEventLogged = false;

      for await (const message of sdkQuery) {
        if (!firstEventLogged) {
          debug(`compact summary: first event type=${message.type}`);
          firstEventLogged = true;
        }
        if (wasAborted) break;

        if (message.type === "assistant") {
          for (const block of message.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string")
              assistantText += block.text;
          }
        } else if (message.type === "result") {
          logServedContextWindow(debug, "compact summary", message, model);
          if (message.subtype === "success") {
            finalText = message.result || assistantText;
            terminalUsage = message.usage;
          } else {
            errorText =
              resultErrorText(message) ?? `Claude Code summary failed: ${message.subtype}`;
          }
        }
      }

      if (wasAborted) {
        const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
        debug("compact summary: aborted");
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }

      const text = finalText || assistantText;
      if (errorText || !text.trim()) {
        const msg = errorText ?? "Claude Code summary returned empty text";
        debug(`compact summary: error ${msg}`);
        stream.push({
          type: "error",
          reason: "error",
          error: newAssistantOutput(model, "", "error", msg),
        });
        stream.end();
        return;
      }

      const output = newAssistantOutput(model, text, "stop");
      if (terminalUsage) {
        applySdkUsage(output, terminalUsage, model);
        debugSdkUsage(debug, output, model);
      }
      debug(`compact summary: done textLen=${text.length}`);
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (err) {
      const msg = errorMessage(err);
      debug("runIsolatedSummary threw; pushing terminal error", err);
      stream.push({
        type: "error",
        reason: "error",
        error: newAssistantOutput(model, "", "error", msg),
      });
      stream.end();
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
      try {
        sdkQuery?.close();
      } catch {}
    }
  }

  async function run(request: CompactionRequest): Promise<CompactionResult> {
    reinjectPriorCompactionFileOps(
      request.branchEntries,
      request.preparation as { fileOps: { read: Set<string>; edited: Set<string> } },
    );
    const retry = loadRetryPolicy(request.cwd, request.projectTrusted);
    debug(
      `compact takeover: retry enabled=${retry.enabled} maxRetries=${retry.maxRetries} baseDelayMs=${retry.baseDelayMs}`,
    );
    const isolatedStreamFn = (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      void runIsolatedSummary(model, context, options, stream, request.cwd);
      return stream;
    };
    return compact(
      request.preparation,
      request.model,
      undefined,
      undefined,
      request.customInstructions,
      request.signal,
      undefined,
      isolatedStreamFn,
      undefined,
      retry,
    );
  }

  return { run };
}
