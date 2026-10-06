---
name: morpheus-dev-protocol
description: "Mandatory operating rules for changing morpheus-self-hosted: the verified branch→verify→PR→merge SOP, the never-push-to-main rule, resync-before-work, and the single-writer constraint from incident H9."
whenToUse: "Load before making ANY change to morpheus-self-hosted — editing files, committing, pushing, opening or merging PRs, or invoking the internal self-dev (Morpheus) build flow."
---

# Morpheus dev protocol

These rules are not style preferences. They exist because this repo has already
been damaged in production by exactly the failure they prevent (see
`KNOWN-HAZARDS.md` H9, and the `morpheus-hazards` skill).

## Non-negotiables

1. **Never push to `main`.** Not directly, not "just this once", not for a
   one-line fix, not with `--force`. `main` auto-publishes to Netlify and
   deploys the backend on Northflank.
2. **DSH is the only writer.** Do not run a Claude Code session against this repo
   at the same time. H9 was two agent sessions writing to the same `main` — one
   silently reverted ~45 files, including a shipped security fix (`blockWidget`),
   because it was diffing against a stale local snapshot.
3. **Branch from freshly-fetched `origin/main`**, every task. Never reuse a
   pushed branch; never branch from a stale local `main`.
4. **Never `git push --force`** to a shared branch. Force-push only your own
   unmerged branch, and only before anyone has reviewed it.
5. **One logical change per branch.** If the diff is bigger than the task, stop
   and say so rather than pushing it.

## The established ship sequence

Rob's repeatedly-used SOP for this repo (ported from his Claude Code memory,
last modified 2026-09-15):

```bash
# 1. branch — from the real remote tip, never stale local main
git fetch origin && git switch -c dsh/<slug> origin/main

# 2. implement

# 3. verify — see the bar below. A syntax check is NOT verification.
npm run lint && npm run build      # build rewrites src/MORPHEUS_DESIGN_PLAN.md (H3)
git checkout -- src/MORPHEUS_DESIGN_PLAN.md

# 4. commit — heredoc -F, so multi-line messages survive intact
git add -A
git commit -F - <<'MSG'
<subject line>

<body>
MSG

# 5. push the BRANCH
git push -u origin dsh/<slug>

# 6. open the PR
gh pr create --fill

# 7. poll for CI — CLI, not the browser (the web UI is slow to refresh state)
gh pr checks <N>
gh pr view <N> --json mergeable,mergeStateStatus

# 8. merge
gh pr merge <N> --squash --subject "<subject>"

# 9. clean up
git switch main && git pull && git branch -d <branch>
```

### Merging is yours once checks pass

Settled 2026-09-19: **the agent merges.** Run `gh pr merge <N> --squash` after
checks pass, then clean up. (The earlier "hand Rob the merge" note came from a
badly-framed question — it offered "agent never merges" versus "agent pushes
straight to `main`", when the real workflow is a third thing: merge *through* the
PR.)

The protection that matters is that **nothing reaches `main` except through a
PR** — never `git push` to `main` directly, which `.githooks/pre-push` blocks.
Merging the PR is the sanctioned path, not a shortcut around it.

**Before merging, check all four:**

1. No runtime code under `src/` or `server/` unless the task called for it
   (`gh pr view <N> --json files`)
2. All checks green (`gh pr checks <N>`)
3. `gh pr view <N> --json mergeable,mergeStateStatus` → `MERGEABLE` / `CLEAN`
4. The runtime gate passes locally: `node scripts/verify.mjs` — it boots the real
   server, resolves every relative import, and runs every pure guard. **If the
   change touches `server/prisma/schema.prisma`, `scripts/verify-schema-prod.mjs`
   must exit 0 (no drift).** A missing credential is exit 2 — "not verified",
   never "passed" — and blocks the merge just as firmly as drift does.

## The verification bar

"It builds" is not verification. Rob's standard, in his own framing:

- **One command, every time:** `node scripts/verify.mjs`. It runs **every**
  guard in `scripts/verify-*.mjs`, then `boot-smoke` — which actually boots
  `server/src/index.js` in production mode and asserts `/api/health` returns 200
  — and finally `verify-schema-prod.mjs` on its own, because that one needs a
  production credential and reports "not verified" (exit 2) rather than pass/fail.
  The boot step is the one that catches the class of failure (H12) that a syntax
  check is structurally blind to, and it was exactly the step skipped on
  2026-09-19.

  **The list is not repeated here on purpose** — it went stale the moment a
  guard was added. `verify-context.mjs` asserts that every guard on disk is run
  by the gate and that CI runs each of them, so a new guard cannot be added and
  silently not run. A guard you only meet in CI is a guard that surprises you
  after you have decided the change was fine.
- **Frontend:** `npm run lint` + `npm run build`.
- **Backend / logic:** `node --check`, plus a real runtime verification script
  exercising the actual function against representative or real inputs. Not a
  syntax check. Not a mock.
- **After any schema change: `node scripts/verify-schema-prod.mjs` must exit 0.**
  It diffs `schema.prisma` against the live Supabase database and fails if the
  schema has a column or table production is missing. A migration file in the
  repo is not proof it ran — this check is. Skipping it caused the multi-hour
  "constructs disappeared" incident (H11), and missing the column check cost
  eight hours of a broken Workspace.
- **Real evidence for real claims:** Northflank or GitHub Actions logs, live DB
  queries, live API calls — instead of reasoning about what probably happened.

## Verify a running UI change

A passing build is not proof the UI works. Load it in a real browser:

```bash
scripts/pw open http://localhost:5173
scripts/pw find "<something you expect to see>"
scripts/pw console error
scripts/pw close
```

Never report a user-visible change as working without having observed it render.

## Keeping the docs honest

This project's hand-written memory went stale **eight times in a single day**
(2026-09-19). Every failure had the same shape: a document held a fact the code
had moved past. Curation preserves rules well and facts badly, so they are split:

- **Rules and judgement** live in a skill — "never push to `main`", the own-data
  rule, how Rob works, Jarvis's persona.
- **Facts** are generated or checked — `node scripts/context.mjs` prints the
  current inventory from the code, and `scripts/verify-context.mjs` (run in CI)
  asserts what the docs claim against the code.

The working rule when writing or editing a skill:

> **If a sentence contains a file path, a count, a route, or the words "not yet
> built", it belongs in `scripts/context.mjs` or in a check — not in a skill.**

A status snapshot is accurate for a day and then quietly misleads. If you need
to know whether something exists, read the code or run the generator. Do not
write it down here.

**When you learn something new, it goes in three places, in this order:**

1. the **guard** that enforces it (`scripts/verify-*.mjs`, or the relevant
   harness) — a lesson here runs on every pull request;
2. the **card** that explains it in `.dsh/skills/morpheus-build-library/references/`
   — so the next session finds it instead of re-learning it;
3. `KNOWN-HAZARDS.md` — only if it actually broke production.

A lesson in a commit message is read once. That ordering is the whole point: if
step 1 is impossible, say so on the card rather than pretending the rule is
enforced.

There are four memory sources, and each answers a different question:

| Source | Answers |
|---|---|
| `node scripts/context.mjs` | what the system **is** right now — derived from the code |
| `node scripts/sessions.mjs "<q>"` | what we **did** and why, across past sessions |
| `scripts/verify-context.mjs` (CI) | whether the docs still **agree** with the code |
| `KNOWN-HAZARDS.md` | what has already **broken** in production — written by the failure path, not by memory |

`sessions.mjs` is the only one that captures *reasoning*. Docs record
conclusions; the session logs record what was tried, what was ruled out, and
why — searchable with `--kind user,assistant,tool,result` and `--reasoning`.

## Related

- `working-with-rob` — his standing priorities and how he expects results reported.
- `morpheus-hazards` — the H1–H23 list to check every change against.
- `morpheus-stack` — stack map, commands, key files.
- `morpheus-build-library` — the index of build knowledge, one short card per
  topic. Load it when the task touches something unfamiliar, and add to it when
  you learn something.
- `KNOWN-HAZARDS.md` in the repo root is the authoritative, maintained source.
