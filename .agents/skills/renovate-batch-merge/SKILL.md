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

Then re-record the stream fixtures. That diff is the SDK's observable contract change and catches the behavior shifts the declarations hide. It costs quota, so it belongs to Agent SDK bumps rather than every batch. Fold the re-recorded fixtures into the batch commit.

Record what you found. If the bump enables work, open an issue or add it to `TODO.md` in the same commit rather than expanding the batch — the batch stays a batch. If it enables nothing, say so in the report; a negative result still means the audit happened.

Done when the SDK diff has been read and its consequences are either landed, filed, or explicitly reported as none.

### 4. Verify

Done when the batch commit's `main` CI is green. Fix a red run before reconciling.

### 5. Reconcile

Give Renovate a few minutes to close the landed PRs. For any it leaves open once its update is on `main`, close it manually with a comment along the lines of `Closing as superseded by <commit>, which already applies this update on main.`

Done when no PR whose update is on `main` remains open.

### 6. Report

Report the batch commit SHA and its updates, the Anthropic SDK audit findings, the `main` CI result and URL, which PRs Renovate closed versus closed by hand, and anything left open with why.
