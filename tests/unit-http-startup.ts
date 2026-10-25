import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type { HttpEnvironmentConfig } from "http-doppelclaude";
import { runHttpDaemon } from "http-doppelclaude/startup";

function config(stateDir: string): HttpEnvironmentConfig {
  return {
    apiKey: "not-a-secret-used-outside-the-test",
    openCodeEnvironmentHeading: undefined,
    host: "127.0.0.1",
    port: 3456,
    stateDir,
    recordRequestsPath: undefined,
    logFilePath: undefined,
    maxRuntimes: 32,
    idleTtlMs: 1000,
    maxBodyBytes: 1000,
    requestTimeoutMs: 1000,
    shutdownTimeoutMs: 1000,
    retryAttempts: 0,
    allowExtraUsage: false,
  };
}

class FakeServer extends EventEmitter {
  listened = false;
  listen(_port: number, _host: string, callback: () => void): this {
    this.listened = true;
    callback();
    return this;
  }
  close(callback?: () => void): this {
    callback?.();
    return this;
  }
}

describe("HTTP startup", () => {
  it("probes before bind, secures state, and passes the discovered cap", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "http-startup-")), "state");
    const order: string[] = [];
    const fake = new FakeServer();
    let serverOptions:
      | { toolDescriptionCap?: number; supportedModels?: readonly { value: string }[] }
      | undefined;
    const supportedModels = [{ value: "claude-opus-5", displayName: "Opus", description: "" }];
    await runHttpDaemon({
      environment: {},
      loadConfig: async () => config(stateDir),
      installSignal: () => {},
      accountProbe: async () => {
        order.push("account");
        return { available: true, supportedModels };
      },
      descriptionCapProbe: async (path) => {
        order.push("cap");
        assert.equal(path, join(stateDir, "description-cap-cache.json"));
        return 8192;
      },
      createServer: ((options: { toolDescriptionCap?: number }) => {
        order.push("create");
        serverOptions = options;
        return fake as unknown as Server;
      }) as never,
    });
    assert.deepEqual(order, ["account", "cap", "create"]);
    assert.equal(fake.listened, true);
    assert.equal(serverOptions?.toolDescriptionCap, 8192);
    assert.equal(serverOptions?.supportedModels, supportedModels);
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  });

  it("binds a real listener to the configured address after mocked probes", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "http-startup-")), "state");
    const server = await runHttpDaemon({
      environment: {},
      loadConfig: async () => ({ ...config(stateDir), host: "0.0.0.0", port: 0 }),
      installSignal: () => {},
      accountProbe: async () => ({ available: true, supportedModels: [] }),
      descriptionCapProbe: async () => 8192,
      createServer: (() => createServer()) as never,
    });
    assert.ok(server);
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "0.0.0.0");
    assert.equal(address.family, "IPv4");
    assert.ok(address.port > 0);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not create or bind a server when the account is unavailable", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "http-startup-")), "state");
    let created = false;
    await assert.rejects(
      runHttpDaemon({
        environment: {},
        loadConfig: async () => config(stateDir),
        installSignal: () => {},
        accountProbe: async () => ({ available: false, supportedModels: [] }),
        descriptionCapProbe: async () => 8192,
        createServer: (() => {
          created = true;
          return new FakeServer() as unknown as Server;
        }) as never,
      }),
      /first-party account/u,
    );
    assert.equal(created, false);
  });

  it("cancels a hanging prebind probe and never creates a socket", async () => {
    const stateDir = join(await mkdtemp(join(tmpdir(), "http-startup-")), "state");
    const listeners = new Map<string, () => void>();
    let created = false;
    let observedSignal: AbortSignal | undefined;
    const exits: number[] = [];
    const started = runHttpDaemon({
      environment: {},
      loadConfig: async () => config(stateDir),
      installSignal(signal, listener) {
        listeners.set(signal, listener);
        return () => listeners.delete(signal);
      },
      accountProbe: async () => ({ available: true, supportedModels: [] }),
      descriptionCapProbe: (_path, signal) => {
        observedSignal = signal;
        return new Promise<number>(() => {});
      },
      createServer: (() => {
        created = true;
        return new FakeServer() as unknown as Server;
      }) as never,
      exit: (code) => exits.push(code),
    });
    while (!observedSignal) await new Promise((resolve) => setImmediate(resolve));

    listeners.get("SIGTERM")?.();
    assert.equal(await started, undefined);
    assert.equal(observedSignal.aborted, true);
    assert.equal(created, false);
    assert.deepEqual(exits, [0]);
    assert.equal(listeners.size, 0);
  });

  it("keeps records in a log file that rotates at its size cap across restarts", async () => {
    mock.method(process.stderr, "write", () => true);
    const stateDir = await mkdtemp(join(tmpdir(), "http-startup-log-"));
    const logFilePath = join(stateDir, "records.jsonl");
    const start = async () => {
      let log: ((record: Record<string, unknown>) => void) | undefined;
      await runHttpDaemon({
        environment: {},
        loadConfig: async () => ({ ...config(stateDir), logFilePath }),
        installSignal: () => {},
        accountProbe: async () => ({ available: true, supportedModels: [] }),
        descriptionCapProbe: async () => 8192,
        createServer: ((options: { log: typeof log }) => {
          log = options.log;
          return new FakeServer() as unknown as Server;
        }) as never,
      });
      assert.ok(log);
      return log;
    };
    const events = async (path: string) =>
      (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).event);
    const filler = "x".repeat(1024 * 1024);
    try {
      const first = await start();
      for (let index = 0; index < 63; index++) first({ event: "before", filler });
      // A restarted daemon must count the bytes already in the file, or it would never rotate.
      const second = await start();
      second({ event: "rotates", filler });
      second({ event: "after", filler });

      const rotated = await events(`${logFilePath}.1`);
      assert.deepEqual(rotated, ["startup", ...Array(63).fill("before"), "startup"]);
      assert.ok((await stat(`${logFilePath}.1`)).size <= 64 * 1024 * 1024);
      assert.deepEqual(await events(logFilePath), ["rotates", "after"]);
      await assert.rejects(stat(`${logFilePath}.2`));
      assert.equal((await stat(logFilePath)).mode & 0o777, 0o600);
    } finally {
      mock.restoreAll();
    }
  });
});
