import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { debug } from "doppelclaude/debug";
import {
  createDefaultDescriptionCapProbe,
  FALLBACK_TOOL_DESCRIPTION_CAP,
} from "doppelclaude/description-cap";
import type { ProviderSettings } from "./settings.js";

export * from "doppelclaude/description-cap";

export interface ToolDescriptionCap {
  get(): number | false;
  start(): Promise<void>;
  onSessionStart(notify: (message: string) => void): void;
  onSessionShutdown(): void;
}

export function createToolDescriptionCap(dependencies: {
  providerSettings: ProviderSettings;
  probe(path: string | undefined, warn: (message: string) => void): Promise<number>;
  debug(...args: unknown[]): void;
}): ToolDescriptionCap {
  const { providerSettings, probe, debug: log } = dependencies;
  const configuredCap = providerSettings.toolDescriptionCap;
  let cap = configuredCap ?? FALLBACK_TOOL_DESCRIPTION_CAP;
  let notify: ((message: string) => void) | undefined;
  let pendingWarning: string | undefined;
  let startPromise: Promise<void> | undefined;
  const warn = (message: string) => {
    if (notify) notify(message);
    else pendingWarning = message;
  };
  return {
    get: () => cap,
    start() {
      if (configuredCap !== undefined) return Promise.resolve();
      startPromise ??= probe(providerSettings.pathToClaudeCodeExecutable, warn)
        .then((value) => {
          cap = value;
        })
        .catch((error) => log("description-cap: asynchronous probe failed", error));
      return startPromise;
    },
    onSessionStart(nextNotify) {
      notify = nextNotify;
      if (pendingWarning) {
        notify(pendingWarning);
        pendingWarning = undefined;
      }
    },
    onSessionShutdown() {
      notify = undefined;
    },
  };
}

export function createDefaultToolDescriptionCap(settings: ProviderSettings): ToolDescriptionCap {
  return createToolDescriptionCap({
    providerSettings: settings,
    debug,
    probe: (pathToClaudeCodeExecutable, warn) =>
      createDefaultDescriptionCapProbe({
        cachePath: join(getAgentDir(), "description-cap-cache.json"),
        pathToClaudeCodeExecutable,
        debug,
        warn,
      })(),
  });
}
