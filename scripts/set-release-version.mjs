#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { coreDependents, packagePaths, readJson, root, stableVersion } from "./release-state.mjs";

const version = process.argv[2];
if (!version || !stableVersion.test(version)) {
  console.error("usage: node scripts/set-release-version.mjs STABLE_SEMVER");
  process.exit(2);
}

for (const packagePath of packagePaths) {
  const manifest = await readJson(packagePath);
  manifest.version = version;
  if (coreDependents.includes(packagePath)) {
    manifest.dependencies.doppelclaude = version;
  }
  await writeFile(resolve(root, packagePath), `${JSON.stringify(manifest, null, 2)}\n`);
}
