---
name: rebase
description: Rebase the pi-claude-bridge fork main branch onto upstream with the smallest possible diff, keeping the fork changes as one coherent commit.
---

# Rebase

Use this skill in `pi-claude-bridge` when upstream has moved and the fork needs updating.

## Mental model

This repository is a fork of `elidickinson/pi-claude-bridge`.

- `upstream/main` is the source project.
- `main` is the fork branch used locally and by Pi.
- `release` is a convenience branch on top of `main` that carries this skill/runbook.
- Keep fork-specific runtime changes as a small, reviewable patch on top of upstream.

Invariant: **one fork commit on `main`, one runbook commit on `release`**.

```text
release
└─ docs(skill): document fork rebase workflow
   └─ main
      └─ feat(provider): custom prompt for Pi Anthropic replacement
         └─ upstream/main
```

If `main` has more than one unique commit over `upstream/main`, or `release` has more than one unique commit over `main`, stop and ask before continuing.

## First gate: check whether there is anything to rebase

Fetch upstream without pruning fork-only tags:

```bash
git -c fetch.pruneTags=false fetch upstream --prune --no-tags
git -c fetch.pruneTags=false fetch upstream --tags
```

Do **not** combine `--tags` and `--prune` when fetching `upstream`. Global prune-tags settings can still delete fork-only local tag refs.

Stop immediately if upstream has not moved beyond `main`'s base:

```bash
git merge-base --is-ancestor upstream/main main && echo "main already contains upstream/main"
git log --oneline main..upstream/main
```

If the log is empty and the merge-base check succeeds, there is no upstream rebase work to do, you're done.

## Second gate: delete as much fork code as possible

Before rebasing, inspect whether upstream already supports any fork behavior:

- replacing the Claude Code preset with a custom/Pi-derived system prompt
- configuring `systemPromptMode`
- disabling Claude setting sources for replace mode
- registering the provider as `anthropic`
- suppressing Claude cloud MCP servers
- tool-name guidance for MCP-prefixed tool names

Decision rules:

- If upstream now supports all desired behavior, recommend deleting the fork and using upstream directly.
- If upstream implements part of the behavior, delete that part from the fork and keep only missing pieces.
- If upstream implements the behavior differently, prefer upstream's version unless it cannot effectively reproduce this fork's Pi behavior, in which case you should consult with the user so they may decide how to proceed.

## Rebase `main`

Confirm the invariant:

```bash
git checkout main
git rev-list --count upstream/main..main
git log --oneline upstream/main..main
```

Expected: one fork commit.

Then rebase:

```bash
git rebase upstream/main
```

Conflict policy:

- Keep upstream code/import/dependency style unless the fork feature requires changing it.
- Keep only fork-relevant behavior.
- Delete fork code that upstream now covers.
- Do not add release metadata or package renames.
- Keep prompt-rewrite behavior isolated in `src/system-prompt.ts`.

## Verify

After rebasing:

```bash
npm run typecheck
pi -ne -e ../pi-claude-bridge/src/index.ts -nt -p --model anthropic/claude-haiku-4-5 'Reply with exactly: bridge-ok'
pi -ne -e ../pi-claude-bridge/src/index.ts -p --model anthropic/claude-haiku-4-5 'Use bash to print exactly bridge-tool-ok, then report the output.'
```

Review the fork diff:

```bash
git log --oneline --decorate --graph upstream/main..main
git diff --stat upstream/main..main
git diff upstream/main..main
```

## Rebase `release`

The `release` branch exists only so this runbook is available in the local/fork workflow without polluting the upstream PR branch.

After `main` is rebased and verified:

```bash
git checkout release
git rebase main
```

Verify the release-only diff is just this skill or other local fork-operation docs:

```bash
git log --oneline main..release
git diff --stat main..release
git diff main..release
```

Expected: one docs/runbook commit.

## Push

Push the rebased fork branches:

```bash
git push --force-with-lease origin main
git push --force-with-lease origin release
```

## Update this skill

At the end, update `.agents/skills/rebase/SKILL.md` on `release` if anything about the process was wrong, missing, or changed. The skill is the runbook; keep future rebases less annoying.
