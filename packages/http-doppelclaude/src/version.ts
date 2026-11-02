import { readFile } from "node:fs/promises";

/** The release version that `scripts/set-release-version.mjs` writes into this package. */
export async function packageVersion(): Promise<string> {
  const manifest = new URL("../package.json", import.meta.url);
  const value = JSON.parse(await readFile(manifest, "utf8")) as { version: string };
  return value.version;
}
