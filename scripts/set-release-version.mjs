#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  console.error("usage: node scripts/set-release-version.mjs STABLE_SEMVER");
  process.exit(2);
}

const root = resolve(import.meta.dirname, "..");
const packagePaths = [
  "package.json",
  "packages/doppelclaude/package.json",
  "packages/pi-doppelclaude/package.json",
  "packages/http-doppelclaude/package.json",
];

for (const packagePath of packagePaths) {
  const path = resolve(root, packagePath);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.version = version;
  if (packagePath === "packages/pi-doppelclaude/package.json") {
    manifest.dependencies.doppelclaude = version;
  }
  if (packagePath === "packages/http-doppelclaude/package.json") {
    manifest.dependencies.doppelclaude = version;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
