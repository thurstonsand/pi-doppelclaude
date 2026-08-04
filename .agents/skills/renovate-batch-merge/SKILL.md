---
name: renovate-batch-merge
description: Use when Renovate has opened its scheduled batch of dependency PRs and the maintainer wants them cleared in one pass instead of reviewed one by one. Lands the whole batch on main as a single commit and lets Renovate close its own PRs.
---

# Renovate Batch Merge

Renovate opens its scheduled updates as a batch of grouped PRs. This skill **lands** the whole batch — majors included — on `main` as one commit; Renovate then **reconciles**, recognizing the updates on `main` and closing the PRs itself.

## Model

- **Land, don't merge.** Read each PR's diff and author the equivalent edit directly on `main`, rather than merging branches or applying patches. The updates are small — version bumps in manifests and lockfiles — so reproduce them by hand and understand what you land.
- **The whole batch, one commit.** Every open Renovate update, plus any formatter fallout it triggers, goes in a single commit. No triage, no held-back majors.
- **Renovate reconciles.** Once the batch is on `main`, Renovate closes the PRs it sees landed. Close a PR by hand only when Renovate leaves it open after its update is already on `main`.

## Workflow

### 1. Inspect

Read the dashboard and list the open batch:

```bash
gh issue list --search "Dependency Dashboard in:title" --state open
gh pr list --author app/renovate --state open \
  --json number,title,url,updatedAt,labels --limit 50
```

Done when you hold the full list of open Renovate PRs.

### 2. Land the batch

Start from a current `main` and for each open Renovate PR, read its diff and make the same edit yourself directly on `main`. Apply every update's manifest and regenerate lockfiles as needed. When a formatter or linter bump in the batch turns the local gate red, run the formatter and fold its mechanical output into the same commit, so the bump and its fallout land together. Commit all changes across all PRs at once.

Done when every open update is authored into one commit on `main` and pushed.

### 3. Audit the Anthropic SDKs

`@anthropic-ai/claude-agent-sdk` is the thing this repo bridges, so its bumps are never routine. Whenever the batch moves it — or `@anthropic-ai/sdk` — read the diff between the old and new versions before moving on. The tenet is "track the Agent SDK closely; delete workarounds the moment it catches up," and this is where that gets enforced.

Diff the installed packages rather than trusting release notes, which are thin:

```bash
npm view @anthropic-ai/claude-agent-sdk versions --json   # what shipped between the two
diff -ru node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts /tmp/new-sdk/sdk.d.ts
```

A workable approach: `npm pack @anthropic-ai/claude-agent-sdk@<old>` and `@<new>` into a temp dir, unpack both, and diff the type declarations and the CLI bundle's changelog.

Look for:

- **New capability that retires a workaround.** `src/bridge-runtime.ts`, `src/session-store.ts`, `src/compaction.ts`, and `src/system-prompt.ts` all carry code that exists only because the SDK could not do something. If it now can, delete ours.
- **Changed or removed surface we depend on.** Control-request shapes, session-store hooks, `query()` options, message and stream event types, permission/tool plumbing.
- **New options worth adopting** even where nothing is broken — model reporting, usage accounting, hooks.

Types compiling clean is not the audit. Behavior can shift under an unchanged signature, so read the diff.

Then re-record the stream fixtures. That diff is the SDK's observable contract change and catches the behavior shifts the declarations hide. Fold the re-recorded fixtures into the batch commit.

Re-recording costs quota, so it is owed when the diff reaches a surface we consume — not on every Agent SDK bump. A release whose whole delta is provably confined to something the bridge never touches cannot move the fixtures, and spending quota to watch them not move is theatre. Say in the report which way you judged it and on what evidence.

Record what you found. If the bump enables work, open an issue or add it to `TODO.md` in the same commit rather than expanding the batch — the batch stays a batch. If it enables nothing, say so in the report; a negative result still means the audit happened.

Done when the SDK diff has been read and its consequences are either landed, filed, or explicitly reported as none.

### 4. Realign what pi ships

`renovate.json` disables `typebox` and `partial-json`. They are pinned to the versions pi ships, and Renovate cannot know what those are, so it will never raise them — they move only when pi moves. That makes a pi bump the one update in a batch that carries hidden work.

When the batch bumps `@earendil-works/pi-*`, read the new `@earendil-works/pi-ai/package.json` and match its `typebox` and `partial-json` pins exactly, in the same commit. Bump the `peerDependencies` floor alongside the devDependency if the new version is actually required.

Then re-read the alias list in pi's extension loader, `packages/coding-agent/src/core/extensions/loader.ts` — the `alias` map for Node and `VIRTUAL_MODULES` for the Bun binary, which must agree. That list, not our imports, decides which packages we need to ship:

- newly aliased — pi now supplies it, so demote ours to a devDependency; it is only typing what pi executes, and it must match pi's version or the types lie
- no longer aliased — pi stopped supplying it, so ours must become a real dependency or the published extension breaks on a machine where nothing else hoists it

Prove the classification rather than trusting the read: move the package out of `node_modules` and run a live smoke that exercises it. Use the global `pi`, since a devDependency copy of pi resolves its own imports normally and will fail for reasons that have nothing to do with the extension.

Done when our pins match pi's, every dependency's placement matches the alias list, and the suite is green.

### 5. Verify

Done when the batch commit's `main` CI is green. Fix a red run before reconciling.

### 6. Reconcile

Give Renovate a few minutes to close the landed PRs. For any it leaves open once its update is on `main`, close it manually with a comment along the lines of `Closing as superseded by <commit>, which already applies this update on main.`

Done when no PR whose update is on `main` remains open.

### 7. Report

Report the batch commit SHA and its updates, the Anthropic SDK audit findings, any pi realignment, the `main` CI result and URL, which PRs Renovate closed versus closed by hand, and anything left open with why.
