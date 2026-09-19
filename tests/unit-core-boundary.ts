import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/doppelclaude/src");
const PI_PACKAGE = /^@earendil-works\/pi-/;
const IMPORT =
  /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function localModule(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const path = resolve(dirname(importer), specifier);
  return extname(path) ? path.replace(/\.js$/, ".ts") : `${path}.ts`;
}

function piDependencies(entry: string): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];

  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (PI_PACKAGE.test(specifier))
        violations.push(`${path.slice(SRC.length + 1)} -> ${specifier}`);
      const local = localModule(path, specifier);
      if (local) pending.push(local);
    }
  }

  return violations.sort();
}

describe("core dependency boundary", () => {
  it("keeps the core package independent of Pi packages", () => {
    assert.deepEqual(piDependencies(resolve(SRC, "bridge-runtime.ts")), []);
  });
});
