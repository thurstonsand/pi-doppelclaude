import { chmod, mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import type { AccountSnapshot } from "doppelclaude/account-probe";
import { createDefaultAccountProbe } from "doppelclaude/account-probe";
import { configureDebug, debug } from "doppelclaude/debug";
import { createDefaultDescriptionCapProbe } from "doppelclaude/description-cap";
import {
  createHttpServer,
  type HttpEnvironmentConfig,
  httpConfigFromEnvironment,
} from "./server.js";

export interface HttpStartupDependencies {
  environment?: NodeJS.ProcessEnv;
  loadConfig?: (env: NodeJS.ProcessEnv) => Promise<HttpEnvironmentConfig>;
  accountProbe?: (signal?: AbortSignal) => Promise<AccountSnapshot>;
  descriptionCapProbe?: (cachePath: string, signal?: AbortSignal) => Promise<number>;
  createServer?: typeof createHttpServer;
  installSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => unknown;
  exit?: (code: number) => void;
}

const STARTUP_TIMEOUT_MS = 30_000;

/** Validate and probe everything before binding the configured socket. */
export async function runHttpDaemon(
  dependencies: HttpStartupDependencies = {},
): Promise<Server | undefined> {
  let server: Server | undefined;
  let config: HttpEnvironmentConfig | undefined;
  let shuttingDown = false;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const startupController = new AbortController();
  const exit = dependencies.exit ?? ((code) => process.exit(code));
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    startupController.abort(new Error("Startup cancelled by shutdown signal"));
    const timeout = config?.shutdownTimeoutMs ?? 15_000;
    shutdownTimer = setTimeout(() => exit(1), timeout + 100);
    shutdownTimer.unref();
    if (!server) {
      clearTimeout(shutdownTimer);
      exit(0);
      return;
    }
    server.close(() => {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      exit(0);
    });
  };
  const install =
    dependencies.installSignal ??
    ((signal, listener) => {
      process.once(signal, listener);
      return () => process.removeListener(signal, listener);
    });
  const removeSignals = [install("SIGINT", shutdown), install("SIGTERM", shutdown)].filter(
    (remove): remove is () => void => typeof remove === "function",
  );
  let signalsRemoved = false;
  const cleanupSignals = () => {
    if (signalsRemoved) return;
    signalsRemoved = true;
    for (const remove of removeSignals) remove();
  };
  const startupTimeout = setTimeout(
    () => startupController.abort(new Error("Startup timed out after 30 seconds")),
    STARTUP_TIMEOUT_MS,
  );
  startupTimeout.unref();
  const cancelled = new Promise<never>((_resolve, reject) => {
    startupController.signal.addEventListener(
      "abort",
      () => reject(startupController.signal.reason),
      { once: true },
    );
  });
  const duringStartup = <T>(operation: Promise<T>): Promise<T> =>
    Promise.race([operation, cancelled]);

  try {
    const env = dependencies.environment ?? process.env;
    config = await duringStartup((dependencies.loadConfig ?? httpConfigFromEnvironment)(env));
    await duringStartup(mkdir(config.stateDir, { recursive: true, mode: 0o700 }));
    await duringStartup(chmod(config.stateDir, 0o700));
    await duringStartup(
      mkdir(join(config.stateDir, "diagnostics"), { recursive: true, mode: 0o700 }),
    );
    configureDebug({
      enabled: env.DOPPELCLAUDE_DEBUG === "1",
      logPath: join(config.stateDir, "doppelclaude.log"),
      diagnosticLogPath: join(config.stateDir, "diagnostics", "unexpected.jsonl"),
    });

    const account = await duringStartup(
      (dependencies.accountProbe ?? createDefaultAccountProbe())(startupController.signal),
    );
    if (!account.available)
      throw new Error("Claude Code is not authenticated with a first-party account subscription");
    const cachePath = join(config.stateDir, "description-cap-cache.json");
    const capProbe =
      dependencies.descriptionCapProbe ??
      ((_path, signal) => createDefaultDescriptionCapProbe({ cachePath, debug })(signal));
    const capTimeout = setTimeout(
      () => startupController.abort(new Error("Description-cap probe timed out after 15 seconds")),
      15_000,
    );
    capTimeout.unref();
    let toolDescriptionCap: number;
    try {
      toolDescriptionCap = await duringStartup(capProbe(cachePath, startupController.signal));
    } finally {
      clearTimeout(capTimeout);
    }

    server = (dependencies.createServer ?? createHttpServer)({
      ...config,
      supportedModels: account.supportedModels,
      toolDescriptionCap,
    });
    await duringStartup(
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server = undefined;
          reject(error);
        };
        server?.once("error", onError);
        server?.listen(config?.port, config?.host, () => {
          server?.removeListener("error", onError);
          resolve();
        });
      }),
    );
    process.stderr.write(`doppelclaude HTTP server listening on ${config.host}:${config.port}\n`);
    server.once("close", cleanupSignals);
    return server;
  } catch (error) {
    if (shuttingDown) return undefined;
    throw error;
  } finally {
    clearTimeout(startupTimeout);
    if (!server) {
      cleanupSignals();
      if (shutdownTimer) clearTimeout(shutdownTimer);
    }
  }
}
