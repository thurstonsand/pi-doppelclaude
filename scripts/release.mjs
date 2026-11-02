#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  compareVersions,
  packagePaths,
  parseChangelog,
  releaseProblems,
  root,
  stableVersion,
} from "./release-state.mjs";

const version = process.argv[2];
if (process.argv.length !== 3 || !stableVersion.test(version)) {
  console.error("usage: mise run release X.Y.Z");
  process.exit(2);
}
const tag = `v${version}`;

function refuse(reason) {
  console.error(`release ${version} refused: ${reason}`);
  process.exit(1);
}

function run(command, args, input) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", input }).trim();
}

if (run("git", ["branch", "--show-current"]) !== "main") refuse("not on main");
if (run("git", ["status", "--porcelain"]) !== "") refuse("the working tree is not clean");
run("git", ["fetch", "--quiet", "origin", "main"]);
const head = run("git", ["rev-parse", "HEAD"]);
if (head !== run("git", ["rev-parse", "origin/main"])) refuse("main does not match origin/main");

const runs = JSON.parse(
  run("gh", ["run", "list", "--commit", head, "--json", "workflowName,status,conclusion,url"]),
);
if (!runs.some((entry) => entry.workflowName === "CI")) refuse(`CI has not run on ${head}`);
for (const entry of runs) {
  if (entry.status !== "completed" || entry.conclusion !== "success") {
    refuse(`${entry.workflowName} on ${head} is ${entry.conclusion || entry.status}: ${entry.url}`);
  }
}

const problems = await releaseProblems();
if (problems.length > 0) refuse(problems.join("; "));

const changelogPath = resolve(root, "CHANGELOG.md");
const { lines, unreleased, releases } = parseChangelog(await readFile(changelogPath, "utf8"));
if (!unreleased) refuse("CHANGELOG.md has no ## [Unreleased] section");
const entries = lines
  .slice(unreleased.heading + 1, unreleased.end)
  .join("\n")
  .trim();
if (entries === "") refuse("## [Unreleased] is empty");
if (compareVersions(version, releases[0].version) <= 0) {
  refuse(`${version} is not greater than ${releases[0].version}`);
}

const today = new Date();
const date = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, "0"),
  String(today.getDate()).padStart(2, "0"),
].join("-");
lines.splice(unreleased.heading + 1, 0, "", `## [${version}] - ${date}`);
await writeFile(changelogPath, lines.join("\n"));

run(process.execPath, ["scripts/set-release-version.mjs", version]);
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
const staged = await releaseProblems(tag);
if (staged.length > 0) throw new Error(`release prep left problems: ${staged.join("; ")}`);

run("git", ["add", "CHANGELOG.md", "package-lock.json", ...packagePaths]);
run("git", ["commit", "--quiet", "--message", `chore(release): ${version}`]);
const notes = run("scripts/extract-release-notes.sh", [tag]);
run("git", ["tag", "--annotate", tag, "--cleanup=verbatim", "--file=-"], `${notes}\n`);
run("git", ["push", "--atomic", "origin", "main", tag]);
console.log(`released ${tag} at ${run("git", ["rev-parse", "HEAD"])}`);
