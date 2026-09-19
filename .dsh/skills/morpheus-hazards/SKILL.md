---
name: morpheus-hazards
description: "The H1–H10 list of self-inflicted breakage already suffered by morpheus-self-hosted, each with its detection rule. Check every proposed change against this list; a violation is a critical issue, not a nitpick."
whenToUse: "Load before reviewing or writing any change to morpheus-self-hosted, especially changes touching server/src/lib/github.js, prisma/schema.prisma, applyEdits/diff-mode edits, invokeAI calls, self-dev push/sync paths, or external API integrations."
---

# Morpheus known hazards

Mirrors `KNOWN-HAZARDS.md` in the repo root — that file is authoritative and is
appended to by `revertSelfDevPush` and the deploy-failure auto-diagnose flow.
Read it in full when a change touches any area below.

## The list

| # | Hazard | Rule |
|---|---|---|
| **H1** | `server/src/lib/github.js` is imported by every compile + deploy path. A self-dev change once shrank it to suit one caller and broke every other importer at import time — all compiles died before reaching GitHub Actions. | **Never remove or rename an export, or change an exported function's return shape, without updating every caller in the same change.** Adding is fine. When in doubt expose both shapes. Verify runs a cross-file check for named imports of local files that aren't exported. |
| **H2** | `entities.js` `scope()` already lets admins see all rows. An admin query that *also* filtered by `created_by_id: user.id` returned nothing. Still live at `server/src/functions/generateSelfDevManual.js:87`. | In admin-only / self-dev handlers, **do not add `created_by_id: user.id`** to a Prisma `where` for data the admin should see system-wide. Scope by `project_id` / `project_type`. |
| **H3** | `npm run build` runs `scripts/sync-capabilities.mjs` as `prebuild`, which **rewrites `src/MORPHEUS_DESIGN_PLAN.md`**. | Never include that file in a change unless the change is specifically about it — it's build noise. `git checkout -- src/MORPHEUS_DESIGN_PLAN.md`. |
| **H4** | `npm install` in `server/` rewrites `server/package-lock.json` (drops unresolvable `@base44/*` entries). It is gitignored. | **Never add `server/package-lock.json` to a change.** |
| **H5** | `applyEdits()` (`server/src/lib/projectUtils.js`): a `find` matching 0 or 2+ times leaves the file **untouched** — a no-op, never a partial edit. A "successful" diff-mode change can silently ship nothing. | Use `edits` only when `find` is a **verbatim, unique** span of the current file — never reconstructed from memory. Otherwise send full `content`. |
| **H6** | `invokeAI` throws `OUTPUT_TRUNCATED` on `finish_reason: length`. Omitting `maxTokens` hands control to an undocumented provider default that has truncated real builds repeatedly. | **Any `invokeAI` call that can produce multi-file or long output must set a generous explicit `maxTokens`.** |
| **H7** | Self-dev pushes must never touch `base44/`, lockfiles, or binaries. A 2026-09-06 rewrite computed deletions over the whole remote tree and would have wiped them from `main` on the first push. | Deletions are only ever computed over paths where `shouldExclude()` is false; **a truncated remote tree means no deletions at all that push.** |
| **H8** | The backend deploy only runs `prisma generate`, never a migration. Migrations are hand-run `server/prisma/*.sql`. | Every `schema.prisma` change ships `server/prisma/selfdev-<slug>.sql` in the **same change** — idempotent, additive-only DDL. `pushSelfDevToGithub` blocks a schema change with no migration. |
| **H9** | **Production data-loss incident.** `pushSelfDevToGithub.js` diffs against self-dev's local `ProjectFile` snapshot, not live `main`. While it sat stale, a separate Claude Code session merged ~a dozen PRs to `main`; the next push force-corrected `main` back toward the stale snapshot, deleting `blockWidget` (a shipped security fix) and ~45 files. | **Treat self-dev and every other writer of `main` as sessions that must not overlap without a resync.** Click SYNC FROM GITHUB immediately before any BUILD → PUSH turn. The longer-term fix is now **built** (`lib/selfDevDrift.js`): it refuses a push whose `Project.synced_commit` disagrees with main's live HEAD, or that would delete more than 10 files unscoped — on the PR path *and* the direct-to-main path. Overriding it needs `acknowledgeDrift`, which `force` deliberately does not imply. Two caveats: the sync-point half needs `server/prisma/selfdev-add-synced-commit.sql` to have been run (the deletion-shape half needs no migration), and a small 1-2 file drift on an unmigrated workspace still slips through. |
| **H10** | Self-dev built a page against `xtools.wmcloud.org/api/user/global_stats/{username}` — a route that **does not exist** (404) — plus an invented wiki username, and swallowed both failures in try/catch so the page hung on "Loading..." forever. | **Never write code against an external API's shape from memory when a cheap real check exists.** Verify with one HTTP request first. The planner must flag *every* endpoint it isn't certain of; `lib/externalApiCheck.js` now calls flagged endpoints before the coder writes against them. |

## Reviewer instruction

For any proposed change, walk this table and state explicitly whether each item
is touched. A violation of H1, H7, H8, or H9 is **critical** — it can break
production or destroy work — and blocks the change.
