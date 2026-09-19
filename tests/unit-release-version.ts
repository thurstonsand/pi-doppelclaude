import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = new URL("..", import.meta.url).pathname;

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "pipe" });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });
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
