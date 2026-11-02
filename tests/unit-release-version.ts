import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = new URL("..", import.meta.url).pathname;

function exec(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const { code, stderr } = await exec(command, args, cwd);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`);
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;

describe("release version preparation", () => {
  it("versions every package before npm resolves local workspace dependencies", async () => {
    const temp = await mkdtemp(join(tmpdir(), "doppelclaude-release-"));
    try {
      await cp(join(root, "package.json"), join(temp, "package.json"));
      await cp(join(root, "package-lock.json"), join(temp, "package-lock.json"));
      await cp(join(root, "scripts"), join(temp, "scripts"), { recursive: true });
      await cp(join(root, "packages"), join(temp, "packages"), { recursive: true });

      await run(process.execPath, ["scripts/set-release-version.mjs", "1.2.3"], temp);
      await run(
        "npm",
        [
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--offline",
          "--no-audit",
          "--no-fund",
        ],
        temp,
      );

      for (const path of [
        "package.json",
        "packages/doppelclaude/package.json",
        "packages/pi-doppelclaude/package.json",
        "packages/http-doppelclaude/package.json",
      ]) {
        assert.equal((await readJson<{ version: string }>(join(temp, path))).version, "1.2.3");
      }
      for (const frontend of ["pi-doppelclaude", "http-doppelclaude"]) {
        const manifest = await readJson<{ dependencies: { doppelclaude: string } }>(
          join(temp, "packages", frontend, "package.json"),
        );
        assert.equal(manifest.dependencies.doppelclaude, "1.2.3");
      }

      const lock = await readJson<{
        version: string;
        packages: Record<
          string,
          { version?: string; resolved?: string; dependencies?: Record<string, string> }
        >;
      }>(join(temp, "package-lock.json"));
      assert.equal(lock.version, "1.2.3");
      assert.equal(lock.packages["packages/doppelclaude"].version, "1.2.3");
      assert.equal(lock.packages["node_modules/doppelclaude"].resolved, "packages/doppelclaude");
      assert.equal(lock.packages["packages/pi-doppelclaude"].dependencies?.doppelclaude, "1.2.3");
      assert.equal(lock.packages["packages/http-doppelclaude"].dependencies?.doppelclaude, "1.2.3");

      await run("npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], temp);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe("release check", () => {
  const released = [
    "## [Unreleased]",
    "",
    "## [1.2.3] - 2026-11-02",
    "",
    "## [1.2.2] - 2026-10-30",
    "",
  ];

  async function check(changelog: string[], args: string[] = []) {
    const temp = await mkdtemp(join(tmpdir(), "doppelclaude-release-check-"));
    try {
      await cp(join(root, "package.json"), join(temp, "package.json"));
      await cp(join(root, "scripts"), join(temp, "scripts"), { recursive: true });
      for (const name of ["doppelclaude", "pi-doppelclaude", "http-doppelclaude"]) {
        await cp(
          join(root, "packages", name, "package.json"),
          join(temp, "packages", name, "package.json"),
        );
      }
      await run(process.execPath, ["scripts/set-release-version.mjs", "1.2.3"], temp);
      await writeFile(join(temp, "CHANGELOG.md"), ["# Changelog", "", ...changelog].join("\n"));
      return await exec(process.execPath, ["scripts/check-release.mjs", ...args], temp);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  it("passes when the newest release, every package.json and the tag agree", async () => {
    assert.deepEqual(await check(released, ["v1.2.3"]), { code: 0, stderr: "" });
  });

  for (const [name, changelog, args, problem] of [
    [
      "a heading outside the standard",
      released.map((line) => (line === "## [1.2.2] - 2026-10-30" ? "## 1.2.2 — 2026-10-30" : line)),
      [],
      'line 7: "## 1.2.2 — 2026-10-30" is not "## [X.Y.Z] - YYYY-MM-DD"',
    ],
    [
      "a date that is not a day",
      released.map((line) => line.replace("2026-10-30", "2026-02-30")),
      [],
      'line 7: "## [1.2.2] - 2026-02-30" is not "## [X.Y.Z] - YYYY-MM-DD"',
    ],
    [
      "versions out of order",
      [...released, "## [1.2.2] - 2026-10-29", ""],
      [],
      "line 9: 1.2.2 does not come before 1.2.2",
    ],
    [
      "Unreleased below a release",
      [...released.slice(2), ...released.slice(0, 2)],
      [],
      "line 7: ## [Unreleased] must come first",
    ],
    [
      "a newest release the packages are not at",
      ["## [1.3.0] - 2026-11-03", "", ...released.slice(2)],
      [],
      "packages/doppelclaude/package.json is version 1.2.3, CHANGELOG.md is at 1.3.0",
    ],
    ["a tag for another version", released, ["v1.2.4"], "tag v1.2.4 does not match"],
  ] as const) {
    it(`fails on ${name}`, async () => {
      const { code, stderr } = await check([...changelog], [...args]);
      assert.equal(code, 1);
      assert.ok(stderr.includes(problem), stderr);
    });
  }
});
