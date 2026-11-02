# Release

`pi-doppelclaude` publishes to npm and GHCR from GitHub Actions when a stable `v*` tag is pushed.

## Versions and the changelog

Every published package.json on `main` carries the version of the latest release, and the frontends pin `doppelclaude` at that same version. `CHANGELOG.md` has one `## [Unreleased]` section at the top, then `## [X.Y.Z] - YYYY-MM-DD` sections, newest first. pi reads those headings from the copy that pi-doppelclaude ships to show what changed after an update.

`mise run lint:release`, part of `mise run check` and CI, fails when a heading other than `## [Unreleased]` breaks that format, when the versions do not strictly descend, or when the newest release does not match every package.json.

## Release flow

1. Review `## [Unreleased]` in `CHANGELOG.md` and commit any edits to `main`.
2. Push `main` and wait for its CI to pass.
3. Run `mise run release X.Y.Z`.
4. The `Release` and `Container image` workflows check that the tag, every package.json and the changelog's newest release agree, then run CI and publish: npm with the `latest` dist-tag and provenance, and the container image as `X.Y.Z` and `latest`.

`mise run release X.Y.Z` refuses unless it runs on a clean `main` that matches `origin/main` with CI and every other push-triggered run on HEAD green, `## [Unreleased]` has entries, and `X.Y.Z` is greater than the newest release. It then moves Unreleased's entries under `## [X.Y.Z] - <today>`, leaves an empty `## [Unreleased]`, writes `X.Y.Z` into every package.json and the lockfile, commits `chore(release): X.Y.Z`, creates the annotated tag `vX.Y.Z` with that section as its body, and pushes `main` and the tag together.

## Release note extraction

`scripts/extract-release-notes.sh vX.Y.Z` prints the changelog section of a release, heading included. The release task uses it for the tag body.
