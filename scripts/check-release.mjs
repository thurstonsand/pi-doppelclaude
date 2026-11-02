#!/usr/bin/env node

import { releaseProblems } from "./release-state.mjs";

const [tag, ...rest] = process.argv.slice(2);
if (rest.length > 0) {
  console.error("usage: node scripts/check-release.mjs [vX.Y.Z]");
  process.exit(2);
}

const problems = await releaseProblems(tag);
for (const problem of problems) console.error(problem);
process.exit(problems.length > 0 ? 1 : 0);
