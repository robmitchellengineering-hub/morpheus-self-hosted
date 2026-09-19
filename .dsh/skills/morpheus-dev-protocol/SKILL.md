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

**Before merging, check all three:**

1. No runtime code under `src/` or `server/` unless the task called for it
   (`gh pr view <N> --json files`)
2. All checks green (`gh pr checks <N>`)
3. `gh pr view <N> --json mergeable,mergeStateStatus` → `MERGEABLE` / `CLEAN`

## The verification bar

"It builds" is not verification. Rob's standard, in his own framing:

- **Frontend:** `npm run lint` + `npm run build`.
- **Backend / logic:** `node --check`, plus a build/bundle check.
- **A real runtime verification script** exercising the actual function against
  representative or real inputs. Not a syntax check. Not a mock. This is the
  part most often skipped and the part he actually cares about.
- **Real evidence for real claims:** Northflank or GitHub Actions logs, live DB
  queries, live API calls — instead of reasoning about what probably happened.
- **After any schema change: verify it landed in production.** A migration file
  in the repo is not proof it ran. Check `information_schema`, or reload the
  live app and read the console. Skipping this caused a real multi-hour outage
  (`deck_people.email does not exist`).

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
- `morpheus-hazards` — the H1–H10 list to check every change against.
- `morpheus-stack` — stack map, commands, key files.
- `KNOWN-HAZARDS.md` in the repo root is the authoritative, maintained source.
