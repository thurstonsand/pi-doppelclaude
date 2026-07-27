---
name: npm-release
description: Prepare, tag, publish, and verify an npm release for this repo. Use when the user wants to release pi-doppelclaude to npm.
---

# npm Release

Use this skill when preparing and publishing a new release for `pi-doppelclaude`.

## Release model

- Release from `main`.
- npm publishing is tag-driven through `.github/workflows/release.yml`.
- Use `CHANGELOG.md` for human release notes.
- Use the exact same release-note text from `CHANGELOG.md` for the annotated git tag body.
- Stable releases are `vX.Y.Z` tags.
- Stable package tags are immutable. Never force-push a stable release tag.
- The GitHub Action uses npm Trusted Publishing through OIDC.

## 1. Inspect release state

- Check the current git state before touching anything. If the working tree has unrelated changes, leave them alone. If release-relevant changes are uncommitted, ask whether they belong in the release before proceeding.
- Inspect changes since the latest stable tag
- Summarize:
  - user-facing features and fixes
  - package, install, or release changes
  - API changes
  - documentation updates
  - likely semver bump: patch, minor, or major

Ask the user to confirm the target version unless they already specified it.

## 2. Prepare release notes

Promote the `## UNRELEASED` section of `CHANGELOG.md` into a versioned entry, keeping the repo's existing entry format:

```md
## X.Y.Z — YYYY-MM-DD

- **Tag: summary** — detail
```

Omit internal refactors that have no user-facing effect. If the user edits the notes, preserve their wording.

If release mechanics change, update `docs/release.md`.

## 3. Verify locally

Run the offline gate and inspect package contents:

```sh
mise run check
npm pack --dry-run
```

Do not proceed on failures. Fix them or report the blocker. Integration tests (`npm test`) hit live APIs; run them only when the release changes provider behavior.

## 4. Commit release prep

Stage only release-relevant files and commit.

If hooks modify staged files, the commit will fail, ensure the hook is resolved then recommit.

## 5. Push main

Push the release prep commit to `main`

## 6. Create and push the stable tag

Use the final `CHANGELOG.md` entry for the tag notes:

```sh
VERSION=X.Y.Z
scripts/extract-release-notes.sh "v${VERSION}" > "/tmp/pi-doppelclaude-v${VERSION}-notes.md"
cat "/tmp/pi-doppelclaude-v${VERSION}-notes.md"
git tag -a "v${VERSION}" --cleanup=verbatim -F "/tmp/pi-doppelclaude-v${VERSION}-notes.md"
git push origin "v${VERSION}"
```

Do not force-push a stable tag. If a tag already exists, stop and inspect; do not overwrite it.

## 7. Watch GitHub Actions publishing

The tag should trigger the Release workflow.

- Use the `gh` tool to find the release (`gh run list --workflow Release`)
- Watch the release action to completion
- The workflow should run CI, set the package version from the tag, and publish to npm with the `latest` dist-tag.
- If there is an error, inform the user what went wrong, including a proposed fix when feasible.

## 8. Final verification

Confirm npm and git remote state:

```sh
VERSION=X.Y.Z
npm view pi-doppelclaude version dist-tags --json
git ls-remote --tags origin "v${VERSION}"
git status --short
```

Final report should include:

- npm version published
- release commit hash and tag
- workflow watched and whether it passed
- verification status
- any follow-up work or issues encountered
