// Guards the dependencies that have to match the versions pi ships, not the newest release.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;

// Pi hands extensions its own bundled typebox as a virtual module, so the copy in
// this repo is only ever a typechecking stand-in for the one that actually runs.
// A skew between them is invisible at runtime and shows up as schemas that
// typecheck here and misbehave under pi, so pin it and let this test say when the
// pin goes stale: bump `typebox` to whatever pi's next release depends on.
describe("typebox pin", () => {
  const piPinnedVersion = readJson<{ dependencies: { typebox: string } }>(
    "../node_modules/@earendil-works/pi-coding-agent/package.json",
  ).dependencies.typebox;

  it("installs the same typebox pi bundles", () => {
    const installed = readJson<{ version: string }>("../node_modules/typebox/package.json");
    assert.equal(installed.version, piPinnedVersion);
  });

  it("declares that version exactly, so npm update cannot float off it", () => {
    const local = readJson<{ devDependencies: { typebox: string } }>("../package.json");
    assert.equal(local.devDependencies.typebox, piPinnedVersion);
  });
});

// partial-json is the other half of the same decision, reached by a different route.
// Pi does not alias it, so this repo genuinely loads its own copy at runtime — but the
// bridge feeds it the same partially-streamed tool arguments pi-ai does, and a parser
// that disagrees about where an incomplete object ends produces divergent tool calls.
// Hence a runtime dependency rather than a dev one, matching pi-ai's exact pin.
describe("partial-json pin", () => {
  const piPinnedVersion = readJson<{ dependencies: Record<string, string> }>(
    "../node_modules/@earendil-works/pi-ai/package.json",
  ).dependencies["partial-json"];

  it("reads a pin from pi-ai at all", () => {
    assert.ok(piPinnedVersion, "pi-ai no longer depends on partial-json; this guard is stale");
  });

  it("installs the same partial-json pi-ai parses with", () => {
    const installed = readJson<{ version: string }>("../node_modules/partial-json/package.json");
    assert.equal(installed.version, piPinnedVersion);
  });

  it("declares that version exactly, so npm update cannot float off it", () => {
    const local = readJson<{ dependencies: { "partial-json": string } }>("../package.json");
    assert.equal(local.dependencies["partial-json"], piPinnedVersion);
  });
});
