# Release

`pi-doppelclaude` publishes to npm from GitHub Actions when a stable `v*` tag is pushed.

## Release flow

1. Promote the `## UNRELEASED` section of `CHANGELOG.md` into a new `## X.Y.Z — YYYY-MM-DD` entry.
2. Verify locally with `mise run check` and `npm pack --dry-run`.
3. Commit the release prep.
4. Create an annotated `vX.Y.Z` tag using the matching `CHANGELOG.md` entry as the tag body.
5. Push `main` and the tag.
6. The `Release` workflow runs CI, sets the package version from the tag, packs the package, and publishes it to npm with the `latest` dist-tag.

## Release note extraction

Use the helper script to extract the exact release entry for the git tag body:

```sh
VERSION=X.Y.Z
scripts/extract-release-notes.sh "v${VERSION}" > "/tmp/pi-doppelclaude-v${VERSION}-notes.md"
git tag -a "v${VERSION}" --cleanup=verbatim -F "/tmp/pi-doppelclaude-v${VERSION}-notes.md"
```
