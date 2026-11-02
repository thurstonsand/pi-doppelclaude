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
- `mise run release X.Y.Z` cuts the release: it versions the packages, commits, tags with the release's `CHANGELOG.md` section as the body, and pushes.
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

## 2. Review the changelog

`## [Unreleased]` in `CHANGELOG.md` collects the entries as changes land. Review it against the changes since the latest stable tag, keeping the repo's existing entry format:

```md
## [Unreleased]

### Added

- **Tag: summary** — detail
```

Omit internal refactors that have no user-facing effect. If the user edits the notes, preserve their wording. Leave the version heading to the release task.

If release mechanics change, update `docs/release.md`.

## 3. Verify locally

Run the offline gate and inspect package contents:

```sh
mise run check
npm pack --dry-run --workspace pi-doppelclaude
```

Do not proceed on failures. Fix them or report the blocker. Integration tests (`npm test`) hit live APIs; run them only when the release changes provider behavior.

## 4. Commit and push the changelog

Stage only the changelog edits and other release-relevant files, commit, and push `main`. If hooks modify staged files, the commit will fail; resolve the hook and recommit. Wait for every workflow run on the pushed commit to pass (`gh run list --commit "$(git rev-parse HEAD)"`).

## 5. Run the release task

```sh
mise run release X.Y.Z
```

It refuses unless `main` is clean, matches `origin/main`, and every workflow run on HEAD is green, `## [Unreleased]` has entries, and `X.Y.Z` is greater than the newest release. Then it moves the Unreleased entries under `## [X.Y.Z] - <today>`, versions every package.json and the lockfile, commits `chore(release): X.Y.Z`, creates the annotated tag `vX.Y.Z` from that section, and pushes `main` and the tag together.

If it refuses, report the reason; do not work around it. Stable tags are immutable: if a push fails after the tag was created, inspect before retrying, and never force-push a tag.

## 6. Watch GitHub Actions publishing

The tag should trigger the Release workflow.

- Use the `gh` tool to find the release (`gh run list --workflow Release`)
- Watch the release action to completion
- The workflow should check that the tag, package.json files and changelog agree, run CI, and publish to npm with the `latest` dist-tag. The `Container image` workflow publishes the image for the same tag.
- If there is an error, inform the user what went wrong, including a proposed fix when feasible.

## 7. Final verification

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
