import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { debug } from "./debug.js";
import type { ProviderSettings } from "./settings.js";

export const FALLBACK_TOOL_DESCRIPTION_CAP = 2048;
const MIN_TOOL_DESCRIPTION_CAP = 256;
const MAX_TOOL_DESCRIPTION_CAP = 65_536;
const SCAN_CHUNK_SIZE = 1024 * 1024;
const SCAN_OVERLAP = 1024;

const CACHED_VERSION_SCHEMA = Type.Object({
  path: Type.String(),
  mtimeMs: Type.Number({ minimum: 0 }),
  size: Type.Number({ minimum: 0 }),
  cap: Type.Number({ minimum: MIN_TOOL_DESCRIPTION_CAP, maximum: MAX_TOOL_DESCRIPTION_CAP }),
  fallback: Type.Boolean(),
  warned: Type.Boolean(),
});
const CACHE_SCHEMA = Type.Object({ entries: Type.Array(CACHED_VERSION_SCHEMA) });

type CachedVersion = Static<typeof CACHED_VERSION_SCHEMA>;

export interface CapResult {
  cap: number;
  fallback: boolean;
  reason?: string;
}

export interface DescriptionCapProbeDependencies {
  cachePath: string;
  resolveBinaryPath(pathToClaudeCodeExecutable: string | undefined): string;
  scanBinary(path: string): Promise<CapResult>;
  debug(...args: unknown[]): void;
  warn(message: string): void;
}

export interface ToolDescriptionCap {
  get(): number | false;
  start(): Promise<void>;
  onSessionStart(notify: (message: string) => void): void;
  onSessionShutdown(): void;
}

export interface ToolDescriptionCapDependencies {
  providerSettings: ProviderSettings;
  probe(
    pathToClaudeCodeExecutable: string | undefined,
    warn: (message: string) => void,
  ): Promise<number>;
  debug(...args: unknown[]): void;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function scanMatches(
  path: string,
  pattern: RegExp,
): Promise<Array<{ index: number; match: RegExpExecArray }>> {
  const file = await open(path, "r");
  const matches: Array<{ index: number; match: RegExpExecArray }> = [];
  const buffer = Buffer.allocUnsafe(SCAN_CHUNK_SIZE);
  let offset = 0;
  let carry = "";
  try {
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      const chunk = carry + buffer.subarray(0, bytesRead).toString("latin1");
      const chunkStart = offset - carry.length;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(chunk); match; match = pattern.exec(chunk)) {
        matches.push({ index: chunkStart + match.index, match });
        if (match[0].length === 0) pattern.lastIndex++;
      }
      carry = chunk.slice(-SCAN_OVERLAP);
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  return [
    ...new Map(
      matches.map((candidate) => [`${candidate.index}:${candidate.match[0]}`, candidate]),
    ).values(),
  ];
}

export async function scanToolDescriptionCap(path: string): Promise<CapResult> {
  const anchors = await scanMatches(
    path,
    /Server instructions truncated from \$\{[A-Za-z_$][\w$]*\.length\} to \$\{([A-Za-z_$][\w$]*)\} chars/g,
  );
  const identifiers = new Set(anchors.map(({ match }) => match[1]));
  if (anchors.length === 0) {
    return { cap: FALLBACK_TOOL_DESCRIPTION_CAP, fallback: true, reason: "anchor not found" };
  }
  if (identifiers.size !== 1) {
    return {
      cap: FALLBACK_TOOL_DESCRIPTION_CAP,
      fallback: true,
      reason: "anchor named multiple cap identifiers",
    };
  }

  const identifier = anchors[0].match[1];
  const assignments = await scanMatches(
    path,
    new RegExp(`(?:^|[^\\w$])${escapeRegex(identifier)}=(\\d+)`, "g"),
  );
  const candidates = assignments
    .map(({ index, match }) => ({ index, value: Number(match[1]) }))
    .filter(({ value }) => value >= MIN_TOOL_DESCRIPTION_CAP && value <= MAX_TOOL_DESCRIPTION_CAP);
  if (candidates.length === 0) {
    return {
      cap: FALLBACK_TOOL_DESCRIPTION_CAP,
      fallback: true,
      reason: "no in-bounds cap assignment found",
    };
  }

  const distinctValues = new Set(candidates.map(({ value }) => value));
  if (distinctValues.size === 1) return { cap: candidates[0].value, fallback: false };

  const anchorIndex = anchors[0].index;
  const byDistance = [...candidates].sort(
    (left, right) => Math.abs(left.index - anchorIndex) - Math.abs(right.index - anchorIndex),
  );
  const nearestDistance = Math.abs(byDistance[0].index - anchorIndex);
  const nearestValues = new Set(
    byDistance
      .filter(({ index }) => Math.abs(index - anchorIndex) === nearestDistance)
      .map(({ value }) => value),
  );
  if (nearestValues.size === 1) return { cap: byDistance[0].value, fallback: false };
  return {
    cap: FALLBACK_TOOL_DESCRIPTION_CAP,
    fallback: true,
    reason: "ambiguous cap assignments",
  };
}

export function resolveClaudeCodeBinary(pathToClaudeCodeExecutable: string | undefined): string {
  if (pathToClaudeCodeExecutable) return pathToClaudeCodeExecutable;
  const requireFromHere = createRequire(import.meta.url);
  const sdkEntry = requireFromHere.resolve("@anthropic-ai/claude-agent-sdk");
  const requireFromSdk = createRequire(sdkEntry);
  const extension = process.platform === "win32" ? ".exe" : "";
  return requireFromSdk.resolve(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${extension}`,
  );
}

export function createDescriptionCapProbe(
  dependencies: DescriptionCapProbeDependencies,
): (pathToClaudeCodeExecutable?: string) => Promise<number> {
  const { cachePath, resolveBinaryPath, scanBinary, debug: log, warn } = dependencies;
  const cache = new Map<string, CachedVersion>();
  let cacheLoaded: Promise<void> | undefined;

  async function loadCache(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
      if (!Value.Check(CACHE_SCHEMA, value)) {
        log(`description-cap: ignoring malformed cache ${cachePath}`);
        return;
      }
      for (const entry of value.entries) cache.set(entry.path, entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        log(`description-cap: could not read cache ${cachePath}`, error);
    }
  }

  async function persistCache(): Promise<void> {
    const temporaryPath = `${cachePath}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(temporaryPath, `${JSON.stringify({ entries: [...cache.values()] })}\n`);
      await rename(temporaryPath, cachePath);
    } catch (error) {
      log(`description-cap: could not write cache ${cachePath}`, error);
    }
  }

  return async (pathToClaudeCodeExecutable?: string): Promise<number> => {
    cacheLoaded ??= loadCache();
    await cacheLoaded;

    let binaryPath = pathToClaudeCodeExecutable ?? "the Claude Code binary";
    let entry: CachedVersion;
    let cached = false;
    let needsPersist = false;
    try {
      binaryPath = resolveBinaryPath(pathToClaudeCodeExecutable);
      const metadata = await stat(binaryPath);
      const existing = cache.get(binaryPath);
      if (existing && existing.mtimeMs === metadata.mtimeMs && existing.size === metadata.size) {
        entry = existing;
        cached = true;
      } else {
        const result = await scanBinary(binaryPath);
        entry = {
          path: binaryPath,
          mtimeMs: metadata.mtimeMs,
          size: metadata.size,
          cap: result.cap,
          fallback: result.fallback,
          warned: false,
        };
        cache.set(binaryPath, entry);
        needsPersist = true;
        log(
          result.fallback
            ? `description-cap: probe failed for ${binaryPath}; assuming ${result.cap} (${result.reason ?? "unknown reason"})`
            : `description-cap: ${binaryPath} uses cap ${result.cap}`,
        );
      }
    } catch (error) {
      entry = {
        path: binaryPath,
        mtimeMs: 0,
        size: 0,
        cap: FALLBACK_TOOL_DESCRIPTION_CAP,
        fallback: true,
        warned: false,
      };
      log(
        `description-cap: probe failed for ${binaryPath}; assuming ${entry.cap} (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (cached && entry.fallback)
      log(`description-cap: using cached fallback ${entry.cap} for ${binaryPath}`);
    if (entry.fallback && !entry.warned) {
      warn(
        `Could not determine Claude Code's tool description cap from ${binaryPath}; assuming ${entry.cap}.`,
      );
      entry.warned = true;
      if (cache.get(binaryPath) === entry) needsPersist = true;
    }
    if (needsPersist) await persistCache();
    return entry.cap;
  };
}

export function createToolDescriptionCap(
  dependencies: ToolDescriptionCapDependencies,
): ToolDescriptionCap {
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
    get() {
      return cap;
    },
    start() {
      if (configuredCap !== undefined) return Promise.resolve();
      startPromise ??= probe(providerSettings.pathToClaudeCodeExecutable, warn)
        .then((probedCap) => {
          cap = probedCap;
        })
        .catch((error) => {
          log("description-cap: asynchronous probe failed", error);
        });
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

export function createDefaultToolDescriptionCap(
  providerSettings: ProviderSettings,
): ToolDescriptionCap {
  return createToolDescriptionCap({
    providerSettings,
    debug,
    probe: (pathToClaudeCodeExecutable, warn) =>
      createDescriptionCapProbe({
        cachePath: join(getAgentDir(), "description-cap-cache.json"),
        resolveBinaryPath: resolveClaudeCodeBinary,
        scanBinary: scanToolDescriptionCap,
        debug,
        warn,
      })(pathToClaudeCodeExecutable),
  });
}
