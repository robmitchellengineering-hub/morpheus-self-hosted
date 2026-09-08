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
