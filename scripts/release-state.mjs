import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const root = resolve(import.meta.dirname, "..");

export const packagePaths = [
  "package.json",
  "packages/doppelclaude/package.json",
  "packages/pi-doppelclaude/package.json",
  "packages/http-doppelclaude/package.json",
];

/** The frontends pin the core at the version they release with. */
export const coreDependents = [
  "packages/pi-doppelclaude/package.json",
  "packages/http-doppelclaude/package.json",
];

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const unreleasedHeading = "## [Unreleased]";
const releaseHeading = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/;

function isCalendarDate(text) {
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

export function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Reads CHANGELOG.md into its lines, the `[Unreleased]` section, and the releases newest first.
 * Section bounds are line indexes: `heading` is the `## ` line, `end` the next one (or EOF).
 */
export function parseChangelog(text) {
  const lines = text.split("\n");
  const headings = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
  const problems = [];
  const releases = [];
  let unreleased;

  headings.forEach((heading, position) => {
    const line = lines[heading];
    const end = headings[position + 1] ?? lines.length;
    if (line === unreleasedHeading) {
      if (position !== 0) {
        problems.push(`line ${heading + 1}: ${unreleasedHeading} must come first`);
      }
      unreleased = { heading, end };
      return;
    }
    const match = releaseHeading.exec(line);
    if (!match || !stableVersion.test(match[1]) || !isCalendarDate(match[2])) {
      problems.push(`line ${heading + 1}: "${line}" is not "## [X.Y.Z] - YYYY-MM-DD"`);
      return;
    }
    const previous = releases.at(-1);
    if (previous && compareVersions(match[1], previous.version) >= 0) {
      problems.push(`line ${heading + 1}: ${match[1]} does not come before ${previous.version}`);
    }
    releases.push({ version: match[1], date: match[2], heading, end });
  });

  return { lines, unreleased, releases, problems };
}

export async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

/**
 * Everything that keeps the changelog's newest release, every package.json and, when given, the
 * release tag from agreeing.
 */
export async function releaseProblems(tag) {
  const changelog = parseChangelog(await readFile(resolve(root, "CHANGELOG.md"), "utf8"));
  const problems = changelog.problems.map((problem) => `CHANGELOG.md ${problem}`);
  const version = changelog.releases[0]?.version;
  if (!version) return [...problems, "CHANGELOG.md has no release"];

  for (const path of packagePaths) {
    const manifest = await readJson(path);
    if (manifest.version !== version) {
      problems.push(`${path} is version ${manifest.version}, CHANGELOG.md is at ${version}`);
    }
    if (coreDependents.includes(path) && manifest.dependencies.doppelclaude !== version) {
      problems.push(`${path} depends on doppelclaude ${manifest.dependencies.doppelclaude}`);
    }
  }
  if (tag !== undefined && tag !== `v${version}`) {
    problems.push(`tag ${tag} does not match CHANGELOG.md's newest release v${version}`);
  }
  return problems;
}
