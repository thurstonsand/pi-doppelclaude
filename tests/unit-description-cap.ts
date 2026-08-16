import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createDescriptionCapProbe,
  createToolDescriptionCap,
  FALLBACK_TOOL_DESCRIPTION_CAP,
  scanToolDescriptionCap,
} from "../src/description-cap.js";

const roots: string[] = [];

async function fixture(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doppelclaude-description-cap-"));
  roots.push(root);
  const path = join(root, "claude");
  await writeFile(path, contents);
  return path;
}

const ANCHOR = "Server instructions truncated from $" + "{e.length} to $" + "{cap} chars";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createToolDescriptionCap", () => {
  it("uses configured numbers and false without launching a probe", async () => {
    for (const toolDescriptionCap of [4096, false] as const) {
      let probes = 0;
      const cap = createToolDescriptionCap({
        providerSettings: { systemPromptMode: "claude-code", toolDescriptionCap },
        probe: async () => {
          probes++;
          return 8192;
        },
        debug() {},
      });

      await cap.start();
      assert.equal(cap.get(), toolDescriptionCap);
      assert.equal(probes, 0);
    }
  });

  it("uses 2048 until an unset cap's asynchronous probe overwrites it", async () => {
    const cap = createToolDescriptionCap({
      providerSettings: { systemPromptMode: "claude-code" },
      probe: async () => 4096,
      debug() {},
    });

    assert.equal(cap.get(), FALLBACK_TOOL_DESCRIPTION_CAP);
    await cap.start();
    assert.equal(cap.get(), 4096);
  });

  it("buffers a probe warning until a session supplies its notify sink", async () => {
    const cap = createToolDescriptionCap({
      providerSettings: { systemPromptMode: "claude-code" },
      probe: async (_path, warn) => {
        warn("cap warning");
        return FALLBACK_TOOL_DESCRIPTION_CAP;
      },
      debug() {},
    });
    const warnings: string[] = [];

    await cap.start();
    assert.deepEqual(warnings, []);
    cap.onSessionStart((message) => warnings.push(message));
    assert.deepEqual(warnings, ["cap warning"]);
    cap.onSessionStart((message) => warnings.push(message));
    assert.deepEqual(warnings, ["cap warning"]);
  });

  it("delivers probe warnings immediately after session start", async () => {
    const cap = createToolDescriptionCap({
      providerSettings: { systemPromptMode: "claude-code" },
      probe: async (_path, warn) => {
        warn("cap warning");
        return FALLBACK_TOOL_DESCRIPTION_CAP;
      },
      debug() {},
    });
    const warnings: string[] = [];

    cap.onSessionStart((message) => warnings.push(message));
    await cap.start();
    assert.deepEqual(warnings, ["cap warning"]);
  });

  it("clears the notify sink on shutdown and buffers later warnings", async () => {
    let probeWarning = (_message: string) => {};
    let finishProbe = () => {};
    const cap = createToolDescriptionCap({
      providerSettings: { systemPromptMode: "claude-code" },
      probe: (_path, warn) =>
        new Promise<number>((resolve) => {
          probeWarning = warn;
          finishProbe = () => resolve(FALLBACK_TOOL_DESCRIPTION_CAP);
        }),
      debug() {},
    });
    const endedSessionWarnings: string[] = [];
    cap.onSessionStart((message) => endedSessionWarnings.push(message));
    const started = cap.start();

    cap.onSessionShutdown();
    probeWarning("late warning");
    assert.deepEqual(endedSessionWarnings, []);
    const nextSessionWarnings: string[] = [];
    cap.onSessionStart((message) => nextSessionWarnings.push(message));
    assert.deepEqual(nextSessionWarnings, ["late warning"]);
    finishProbe();
    await started;
  });
});

describe("scanToolDescriptionCap", () => {
  it("finds the anchored cap assignment", async () => {
    const path = await fixture(`minified();cap=4096;other();${ANCHOR};tail()`);

    assert.deepEqual(await scanToolDescriptionCap(path), { cap: 4096, fallback: false });
  });

  it("falls back when the anchor is missing", async () => {
    const path = await fixture("minified();cap=4096;no stable anchor here");

    assert.deepEqual(await scanToolDescriptionCap(path), {
      cap: FALLBACK_TOOL_DESCRIPTION_CAP,
      fallback: true,
      reason: "anchor not found",
    });
  });

  it("falls back for equally near conflicting assignments", async () => {
    const rightPadding = 10;
    const leftPadding = ANCHOR.length + rightPadding - "cap=1024".length;
    const path = await fixture(
      `cap=1024${"x".repeat(leftPadding)}${ANCHOR}${"x".repeat(rightPadding)} cap=4096`,
    );

    assert.deepEqual(await scanToolDescriptionCap(path), {
      cap: FALLBACK_TOOL_DESCRIPTION_CAP,
      fallback: true,
      reason: "ambiguous cap assignments",
    });
  });

  it("discards out-of-bounds assignments", async () => {
    for (const cap of [255, 65_537]) {
      const path = await fixture(`cap=${cap};${ANCHOR}`);
      assert.deepEqual(await scanToolDescriptionCap(path), {
        cap: FALLBACK_TOOL_DESCRIPTION_CAP,
        fallback: true,
        reason: "no in-bounds cap assignment found",
      });
    }
  });
});

describe("createDescriptionCapProbe", () => {
  it("caches a scan by path, mtime, and size", async () => {
    const path = await fixture(`cap=3072;${ANCHOR}`);
    let scans = 0;
    const probe = createDescriptionCapProbe({
      cachePath: join(path, "..", "cache.json"),
      resolveBinaryPath: () => path,
      async scanBinary(binaryPath) {
        scans++;
        return scanToolDescriptionCap(binaryPath);
      },
      debug() {},
      warn() {},
    });

    assert.equal(await probe(), 3072);
    assert.equal(await probe(), 3072);
    assert.equal(scans, 1);
  });

  it("invalidates and replaces a path's cached entry when the binary changes", async () => {
    const path = await fixture(`cap=3072;${ANCHOR}`);
    const cachePath = join(path, "..", "cache.json");
    let scans = 0;
    const probe = createDescriptionCapProbe({
      cachePath,
      resolveBinaryPath: () => path,
      async scanBinary(binaryPath) {
        scans++;
        return scanToolDescriptionCap(binaryPath);
      },
      debug() {},
      warn() {},
    });

    assert.equal(await probe(), 3072);
    await writeFile(path, `cap=4096;${ANCHOR};changed-size`);
    assert.equal(await probe(), 4096);
    assert.equal(scans, 2);
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      entries: Array<{ path: string; cap: number }>;
    };
    assert.equal(cache.entries.length, 1);
    assert.equal(cache.entries[0].path, path);
    assert.equal(cache.entries[0].cap, 4096);
  });

  it("does not persist an unavailable binary as a synthetic version", async () => {
    const path = await fixture("removed before probing");
    const cachePath = join(path, "..", "cache.json");
    await rm(path);
    const probe = createDescriptionCapProbe({
      cachePath,
      resolveBinaryPath: () => path,
      scanBinary: scanToolDescriptionCap,
      debug() {},
      warn() {},
    });

    assert.equal(await probe(), FALLBACK_TOOL_DESCRIPTION_CAP);
    await assert.rejects(readFile(cachePath), { code: "ENOENT" });
  });

  it("warns once for each binary version that falls back", async () => {
    const path = await fixture("no anchor");
    const cachePath = join(path, "..", "cache.json");
    const warnings: string[] = [];
    const probe = createDescriptionCapProbe({
      cachePath,
      resolveBinaryPath: () => path,
      scanBinary: scanToolDescriptionCap,
      debug() {},
      warn: (message) => warnings.push(message),
    });

    assert.equal(await probe(), FALLBACK_TOOL_DESCRIPTION_CAP);
    assert.equal(await probe(), FALLBACK_TOOL_DESCRIPTION_CAP);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /assuming 2048/);

    const restartedProbe = createDescriptionCapProbe({
      cachePath,
      resolveBinaryPath: () => path,
      scanBinary: scanToolDescriptionCap,
      debug() {},
      warn: (message) => warnings.push(message),
    });
    assert.equal(await restartedProbe(), FALLBACK_TOOL_DESCRIPTION_CAP);
    assert.equal(warnings.length, 1);

    await writeFile(path, "still no anchor, but a different binary version");
    assert.equal(await probe(), FALLBACK_TOOL_DESCRIPTION_CAP);
    assert.equal(warnings.length, 2);
  });
});
