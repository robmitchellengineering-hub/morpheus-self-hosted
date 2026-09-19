---
name: morpheus-dev-protocol
description: "Mandatory operating rules for any agent changing morpheus-self-hosted. Covers branch/PR-only workflow, the absolute never-push-to-main rule, resync-before-work, and the single-writer constraint that exists because concurrent writers already destroyed production code once (incident H9)."
whenToUse: "Load before making ANY change to the morpheus-self-hosted repository — editing files, committing, pushing, opening PRs, or invoking its internal self-dev (Morpheus) build flow."
---

# Morpheus dev protocol

These rules are not style preferences. They exist because this repo has already
been damaged in production by exactly the failure they prevent
(see `KNOWN-HAZARDS.md` H9, and the `morpheus-hazards` skill).

## Non-negotiables

1. **Never push to `main`.** Not directly, not "just this once", not for a
   one-line fix, not with `--force`. `main` auto-publishes to Netlify and
   deploys the backend on Northflank. Every change reaches `main` through a
   pull request that a human merges.
2. **DSH is the only writer.** Do not run a Claude Code session against this
   repo at the same time. H9 was two agent sessions editing and pushing to the
   same `main` — one of them silently reverted ~45 files, including a shipped
   security fix (`blockWidget`), because it was diffing against a stale local
   snapshot.
3. **Branch from freshly-fetched `origin/main`**, every task, no exceptions.
   Never reuse a branch that has already been pushed, and never branch from a
   stale local `main`.
4. **Never `git push --force` to a shared branch.** Force-push only your own
   unmerged feature branch, and only when nobody else has reviewed it.
5. **One logical change per branch.** If the diff is bigger than the task you
   were given, stop and say so rather than pushing it.

## Standard task loop

```bash
# 1. Start clean, from the real remote tip
cd /Users/mac/code/morpheus-self-hosted
git status                       # must be clean; commit or stash first
git fetch origin
git switch -c dsh/<slug> origin/main

# 2. Do the work, then run the checks the repo's AGENTS.md requires
npm run lint
npm run build                    # NOTE: rewrites src/MORPHEUS_DESIGN_PLAN.md (hazard H3)

# 3. Restore the build-noise file if you did not mean to change it
git checkout -- src/MORPHEUS_DESIGN_PLAN.md

# 4. Commit and push the BRANCH (never main)
git add -A
git commit -m "<focused message>"
git push -u origin dsh/<slug>

# 5. Open a PR for human review
gh pr create --fill
```

## Before you push — the four questions

Answer all four out loud. If any answer is wrong, do not push.

1. What branch am I on, and is it a `dsh/...` branch rather than `main`?
2. Did this branch start from a fresh `origin/main` fetched *today*?
3. Does the diff contain only the files this task needed?
4. Did `npm run lint` and `npm run build` pass?

## Verify a running UI change

A passing build is not proof the UI works. For anything user-visible, actually
load it in a browser via the Playwright MCP tools
(`mcp__playwright__browser_navigate`, then `browser_snapshot`), against the
local Vite dev server on port 5173. Do not report a UI change as working
without having observed it render.

## Related

- `morpheus-hazards` — the H1–H10 list to check every change against.
- `morpheus-stack` — stack map, exact commands, and key files.
- `KNOWN-HAZARDS.md` in the repo root is the authoritative, maintained source;
  these skills summarise it.
