# KNOWN HAZARDS

Self-inflicted breakage that has already happened to this codebase, so it
doesn't happen again. **Self-dev's planner and reviewer are given this file on
every build turn** — the reviewer must check each proposed change against every
item here and flag a violation as a **critical** issue.

New incidents are appended by `revertSelfDevPush` and by the deploy-failure
auto-diagnose flow. When you fix a production break, add the root cause here as
part of the same change.

---

## H1 — `server/src/lib/github.js` is imported by every compile + deploy path
**Incident (2026-09-06, commit `fb2020f`):** a self-dev change rewrote this file
to a smaller shape built only for `pushSelfDevToGithub.js` — dropping
`getGithubToken` / `createRepo` / `pushFiles` / `ghHeaders` / `ghJson` /
`getGhUser` / `encryptAndSetGithubSecret` and changing `getGithubConnection`'s
return shape. Every other importer (`compileProject.js`, `saveCompiledArtifacts.js`,
`getCompileStatus.js`, `deployBackend.js`, `generateRebuildDoc.js`,
`checkGithubConnection.js`, `importFromGithub.js`, `workflow-renderer.js`) broke
at import time with `does not provide an export named …` — **every compile
attempt died before reaching GitHub Actions**, with no Swift/target-specific
error to explain it.

**Rule:** never remove or rename an export from `github.js`, and never change an
exported function's return shape, without updating every caller in the same
change. Adding is fine; removing/renaming/reshaping is not. When in doubt, keep
both shapes (the fix here exposes `token` *and* `accessToken`).

_Now enforced:_ `verifySelfDev` runs a deterministic cross-file check (a named
import of a local file that the file doesn't export → verify fails), and the
reviewer is handed a CALLER IMPACT manifest for every changed shared file. This
applies to any shared module, not just `github.js`.

## H2 — `entities.js` `scope()` bypasses `created_by_id` for admins
**Incident:** self-dev history and project discovery silently returned nothing.
Root cause: admin queries were *additionally* filtering by
`created_by_id: user.id`, but `scope()` already lets admins see all rows — the
extra filter excluded rows created by the system / other flows.

**Still live:** `server/src/functions/generateSelfDevManual.js:87` has this exact
bug (`projectFile.findMany({ where: { created_by_id: user.id } })`).

**Rule:** in any admin-only / self-dev handler, do not add `created_by_id: user.id`
to a Prisma `where` for data the admin is meant to see across the whole system.
Scope by `project_id` / `project_type` instead.

## H3 — `npm run build` rewrites `src/MORPHEUS_DESIGN_PLAN.md`
`prebuild` runs `scripts/sync-capabilities.mjs`, which regenerates that file.
**Rule:** never include `src/MORPHEUS_DESIGN_PLAN.md` in a self-dev change unless
the change is specifically about it — the diff is build noise.

## H4 — `server/package-lock.json` is not committed
`npm install` in `server/` rewrites it (drops the unresolvable `@base44/*`
entries, adds `"dev": true`). It is gitignored. **Rule:** never add
`server/package-lock.json` to a change.

## H5 — coder `edits` must match an exact, unique snippet
`applyEdits()` (`server/src/lib/projectUtils.js`): a `find` string that matches
0 times or 2+ times leaves the file **untouched** (no-op, never partial). A
diff-mode change that "succeeded" but didn't move the file will silently ship
nothing. **Rule:** when using `edits`, the `find` must be a verbatim, unique
span of the current file — not reconstructed from memory. If unsure, use full
`content`.

## H6 — `invokeAI` throws `OUTPUT_TRUNCATED` on `finish_reason: length`
Omitting `maxTokens` does not remove the ceiling — it hands control to the
provider's undocumented default, which has truncated real builds repeatedly
(reviewer, coder, prototype generator — see the comment history in
`reviewer.js`). **Rule:** any `invokeAI` call that can produce multi-file or
long output must set a generous explicit `maxTokens`.

## H8 — a `schema.prisma` change needs its migration in the same change
The backend deploy only runs `prisma generate`, never a migration — the DB is
migrated by hand-run `server/prisma/*.sql`. A `schema.prisma` change that ships
without the matching SQL means the new code hits a column/table that doesn't
exist in production. **Rule:** every `server/prisma/schema.prisma` change ships
`server/prisma/selfdev-<slug>.sql` in the same change — idempotent, additive-only
DDL. `pushSelfDevToGithub` blocks a schema change with no migration;
`applySelfDevMigrations` runs additive ones after the merge (destructive DDL is
left for a human).

## H7 — self-dev pushes must never touch `base44/`, lockfiles, or binaries
`shouldExclude()` (`server/src/lib/selfDevRepo.js`) defines what self-dev
mirrors. A 2026-09-06 rewrite of `pushSelfDevToGithub.js` computed deletions
over the *whole* remote tree and would have wiped `base44/`, both lockfiles and
every binary from `main` on the first real push. **Rule:** deletions are only
ever computed over paths where `shouldExclude()` is false; a truncated remote
tree means no deletions at all that push.

## H9 — a PUSH TO PRODUCTION diffs against self-dev's *local* snapshot, not live `main`
**Incident (2026-09-11, commit `971a1c0`, reverted in `969232a`):**
`pushSelfDevToGithub.js` builds its diff from `ProjectFile` rows — self-dev's
own local workspace mirror — not a fresh read of the actual remote tree. While
one session worked in self-dev, a *separate* Claude Code session was merging
PRs directly to `main` in the same repo (roughly a dozen, #74 through #86) —
self-dev's workspace never saw any of them, since nothing had clicked SYNC FROM
GITHUB since it fell behind. The next PUSH computed a diff against that stale
snapshot and force-corrected `main` back toward it: `blockWidget` (a real,
previously-shipped security fix — see the plugin-widget history) deleted along
with every router's import of it, several other files deleted outright
(`getChatHistory.js`, `EmbedChat.jsx`, `PagesTab.jsx`, more), several more
substantially reverted. ~45 files touched in one push, mixed in with legitimate
new work from the same self-dev turn — nothing in the flow warned that the
diff's size or shape was unusual for what the operator had actually asked for.

**Rule:** treat self-dev and any other route that writes to this repo's `main`
(another Claude Code session, a manual push) as sessions that must not overlap
without a resync in between — **click SYNC FROM GITHUB immediately before any
BUILD → PUSH turn** if there's any chance `main` moved since self-dev's
workspace was last opened or synced, especially with another Claude Code
session active on the same repo. Longer-term, `pushSelfDevToGithub` should
compare its diff's target base (`ProjectFile`'s last-known commit) against
`main`'s actual current HEAD before pushing, and refuse or flag a push whose
diff implies remote drift instead of silently reverting toward a stale
snapshot — not yet built.

## H10 — a plausible-looking external API call was never actually called
**Incident (2026-09-11/12, `/stats/alice`):** self-dev built a page against
`xtools.wmcloud.org/api/user/global_stats/{username}` — a route that does not
exist (confirmed live: 404, "No route found"; XTools has no such cross-wiki
shortcut, every real per-wiki endpoint requires a project domain in the path)
— and a Wikimedia Australia wiki username it invented, which also isn't a real
account there. Both failures were wrapped in their own try/catch and silently
swallowed with no fallback path, so the page never reached a terminal state —
it hung on "Loading..." forever, with no console error pointing at why. Fixed
in the same change that introduced this file: `lib/externalApiCheck.js` +
`chatWithMorpheus.js`'s planner `externalApis` field now actually call a
flagged endpoint before the coder writes a line against it, so a 404 shows up
as ground truth in the coder's prompt instead of being discovered by the
operator days later.

**Rule:** never write code against an external API's shape from memory when a
real, cheap way to check exists. This applies to the coder itself — the
planner's job is to flag *every* external endpoint it isn't certain of,
including "I'm probably right about this one" — verifying costs one HTTP
request; being wrong costs a debugging session.

## H11 — a new column on a *listed* entity breaks the whole feature until the SQL is applied

**Near-miss (2026-09-19, the brain-dump/insight work):** an opt-out setting was
about to be added as a `deck_insight_enabled` column on `DeckBusinessProfile`.
That would have been a production outage, not a missing toggle.

`server/src/entities.js` reads with **no `select`**:

    delegate(name).findMany({ where: scope(user, name), orderBy, take })

Prisma with no `select` fetches *every* column, so on a database that hasn't had
the new column added by hand, that query throws `P2022 — column ... does not
exist`. `CommandDeckContext.jsx` lists `DeckBusinessProfile` (and every other
`Deck*` entity) on **every Deck load**, so the blast radius of one unapplied
column is the entire Deck failing to render — not the new feature being absent.
This is the documented incident class in `lib/templateCompat.js` and the earlier
"Command Deck's main data load was silently broken in production" report, where
`deck_people.email` did not exist.

**Rule:** H8 says ship the migration *with* the change. H11 is the sharper fact:
**you cannot assume the migration has been applied when the code deploys.**
Before adding a field to any model the frontend lists via `base44.entities.*`:

- Prefer not to add the column at all. Reuse an existing control or column when
  the meaning genuinely matches (the proactive-insight opt-out ended up being
  the existing `DeckWidgetInstance.enabled` flag for the `jarvis_suggestions`
  widget — no migration, and a control the operator could already see).
- If a new column is genuinely required, give every read of that model an
  explicit `select`, and add the defensive read/write pair
  (`lib/templateCompat.js`'s error classifier and `Settings.jsx`'s
  "retry without the field" save) **in the same change** — never rely on the
  migration landing first.
- Never make the new field's absence fail closed. A missing column must degrade
  to the old behaviour, not to "feature off for everyone".

