# Self-Dev Pipeline & Shared Delivery Engine — Source Audit

Static read of `/Users/mac/code/morpheus-self-hosted/server/src`. Every claim below cites the file (and line where useful). Nothing here was executed.

---

## 1. Full self-dev lifecycle

The pipeline is: **sync → edit turn → verify → ship (direct or PR) → merge-on-green → auto-deploy → smoke → rollback**, with migrations and the operator manual as side effects.

1. **Sync the mirror.** `functions/importSelfDevRepo.js` (admin-only, line 43). Reads `git/trees/<branch>?recursive=1` for `robmitchellengineering-hub/morpheus-self-hosted@main` (constants in `lib/selfDevRepo.js:15-18`), strips paths matching `shouldExclude()` (`selfDevRepo.js:39-46`), fetches only blobs whose git-blob SHA differs from local (`importSelfDevRepo.js:98-113`, `gitBlobSha` at `selfDevRepo.js:24-27`), upserts `ProjectFile` rows into a singleton `project_type='self_dev'` project, deletes local rows gone upstream, and records `Project.synced_commit` from the **branch ref** (not the tree SHA) at lines 148-155.
2. **Edit turns.** `functions/chatWithMorpheus.js` gates `project_type==='self_dev'` to admins (line 578). On build turns it runs the **deep verify gate** against the in-memory post-edit workspace (`chatWithMorpheus.js:1497-1511`) via the delivery adapter, and applies file ops through `applyFileOperations(..., engineScopePolicy)` (line 1600). Self-dev diagnostic tools (`lib/selfDevTools.js`) are exposed to the turn (`chatWithMorpheus.js:1037-1061`).
3. **Push.** `functions/pushSelfDevToGithub.js` (admin-only, line 65): admin gate → verify gate (lines 76-86, bypassed by `force`) → load `ProjectFile` rows (line 88) → `directToMain = force || body.directToMain` (line 90) → resolve optional `scopePolicy` (lines 99-100) → run `precheck` (lines 104-157) → `getDeliveryAdapter('self-dev').ship(...)` (line 159).
4. **Ship engine.** `lib/engine/ship.js` diffs local files against the **live remote tree** by `gitBlobSha` (lines 79-87), computes deletions as remote paths absent locally (lines 89-95), then either commits straight to the base branch (`directToMain`, lines 115-125) or pushes a `self-dev/<ts>` branch + opens a PR (lines 127-151). One commit per push (`pushFiles`, `github.js:258`).
5. **Merge-on-green.** `functions/mergeSelfDevPr.js` (admin-only, line 81) → adapter `merge` (`lib/delivery/selfDev.js:62-68`) → `lib/engine/merge.js` polls combined checks and squash-merges only when passing, then best-effort deletes the branch.
6. **Deploy.** Northflank + Netlify watch `main` and redeploy — asserted in `lib/delivery/selfDev.js:3-4, 42` (`deployKind: 'northflank-auto'`); no code in this repo triggers it.
7. **Smoke check.** `functions/smokeCheckSelfDev.js` (admin-only, line 32) → adapter `healthCheck` (`selfDev.js:115-133`) probes `${BACKEND_PUBLIC_URL||https://api.morpheus.nz}/api/health`, `/api/auth/me` (expects 401), a function POST, and the frontend root.
8. **Rollback.** `functions/revertSelfDevPush.js` (admin-only, line 35) → adapter `rollback` (`selfDev.js:101-111`) → `github.js:528-567 revertCommit`, which **refuses if the branch head has moved** since `commitSha` (lines 537-539). Also appends a dated incident stub to `KNOWN-HAZARDS.md` (lines 18-32).
9. **Migrations.** `functions/applySelfDevMigrations.js` runs additive-only `server/prisma/selfdev-*.sql` in one transaction per file, tracked in `self_dev_migrations` (`selfDevMigrations.js:50-58`, `applySelfDevMigrations.js:36-57`). Auto-invoked after a direct push (`pushSelfDevToGithub.js:209-218`) and after a PR merge (`mergeSelfDevPr.js:66-74`). Admin-only (line 86).
10. **Manual regen.** `functions/generateSelfDevManual.js` rebuilds the operator manual from `SELF_DEV_ADMIN_MANUAL_SOURCES` (lines 32-44) when a push/merge touched one of those files (`pushSelfDevToGithub.js:200-207`, `mergeSelfDevPr.js:54-61`) or on an admin click. Admin-only (line 145).
11. **Feature planning.** `functions/planSelfDevFeature.js` breaks a goal into 3-8 steps (prompt lines 14-24), persisted via `lib/selfDevFeature.js`. `updateSelfDevFeature.js` advances steps; `lib/selfDevDecisions.js` records/stamps decisions.

---

## 2. Delivery modes

### Engine-level: direct vs PR — `lib/engine/ship.js`
- **Direct** (`directToMain: true`): `pushFiles` to the base branch; returns `{shipped:true, mode:'direct', branch, commitSha, ...}` (lines 115-125).
- **PR** (default): push a `self-dev/<ISO-timestamp>` branch then `createPullRequest`; returns `{mode:'pr', branch, prNumber, prUrl, ...}` (lines 127-151).
- Self-dev's adapter passes `directToMain` straight through and uses `branchPrefix:'self-dev/'` (`delivery/selfDev.js:83-95`). In practice direct mode is reachable only via `force` or an explicit `body.directToMain` (`pushSelfDevToGithub.js:90`).
- WordPress's adapter **hard-codes `directToMain:false`** ("Never direct-to-main for a plugin tenant", `delivery/wordpress.js:103-122`) and additionally sets `noDeletions:true` and `incremental:true`.

### Scoped vs unscoped (self-dev)
- **Unscoped** (Rob's normal push): no `scopePolicy`; the diff is a full-repo mirror, so missing-locally ⇒ deleted.
- **Scoped**: `body.scopePolicy` may be a registered id or an ad-hoc policy object (`resolvePolicy` accepts both, `enginePolicy.js:91-95`). `scopeExcludeFor` turns the policy's `allowPathPrefixes` into a ship-`exclude` predicate (`enginePolicy.js:148-152`), composed on top of `shouldExclude` in `delivery/selfDev.js:87`. Out-of-scope paths are therefore invisible to **both the changed-file diff and the deletion computation**.
- Registered scope: `WIDGET_BUILD` allows only `src/pages/CommandDeck/widgets/`, `server/src/functions/widget[A-Z]*`, and `src/pages/CommandDeck/deckWidgets.js` (`enginePolicy.js:65-87`).
- Ad-hoc scope: `deleteDeckWidget.js:135-142` builds a `widget_delete` policy limited to the one widget file plus `deckWidgets.js`.
- Scoped pushes are driven by privileged internal actors that bypass the HTTP route: `buildDeckWidget.js:234` calls the push handler directly with `{ user: selfDevActor, scopePolicy: 'widget_build' }`; `deleteDeckWidget.js:146` likewise. `resolveSelfDevActor` requires the workspace owner to be an admin (`buildDeckWidget.js:42-47`).
- Scope is also enforced at **write time** in the chat turn: `engineScopePolicy` → `applyFileOperations` → `assertWritable`, which emits `{action:'policy_denied'}` instead of writing (`chatWithMorpheus.js:771,1600`; `projectUtils.js:167-174`). `buildDeckWidget.js:210-218` aborts the whole build if any `policy_denied` op appears.

---

## 3. Safety gates and what each prevents

| Gate | Where | Prevents |
|---|---|---|
| Route `requireAuth` + `requireAdmin` for `ADMIN_FUNCTIONS` | `routes/functions.routes.js:29,50,77-79` | Any non-admin calling a self-dev delivery function. Widget/device tokens are additionally refused for `ADMIN_FUNCTIONS` (lines 65-76). |
| Per-handler `user.role !== 'admin'` | each function's `handler` (see §4) | Same, for direct handler invocation. |
| Ownership scoping | `pushSelfDevToGithub.js:70-73`, `verifySelfDev.js:17-20`, `mergeSelfDevPr.js:32-34` | Acting on a project you don't own / that isn't `project_type==='self_dev'`. |
| Verify gate (esbuild bundle + cross-file exports) | `engine/verify.js:57-134`; called `pushSelfDevToGithub.js:76-86`, `delivery/selfDev.js:51-57` | The H1 class ("does not provide an export named X") that breaks production at import time without a syntax error. `force` overrides. |
| Deep verify on every build turn | `chatWithMorpheus.js:1497-1511` | Same class, caught and auto-fixed *before* the push, with a bounded fix loop. |
| H9 drift guard — sync-point mismatch | `lib/selfDevDrift.js:79-81`, wired `pushSelfDevToGithub.js:110-119` | A stale mirror diffing against live `main` and deleting upstream work (H9 removed ~45 files). |
| H9 drift guard — excess deletions | `selfDevDrift.js:39,86-88` | `>10` deletions in one unscoped push being treated as intent rather than drift (normal: 0-3). |
| Schema-needs-migration | `pushSelfDevToGithub.js:121-130` | Shipping a changed `server/prisma/schema.prisma` without a matching `server/prisma/selfdev-<slug>.sql`. |
| deckWidgets append-only / single-line-removal | `pushSelfDevToGithub.js:138-154`; `selfDevRepo.js:54-83` | A scoped build/delete silently taking another widget's registry entry — checked against the **live remote** content, not the local copy. |
| Engine deletion safety | `engine/ship.js:89-95` | Deleting excluded paths (binaries, lockfiles, `base44/`, `node_modules/`) or deleting at all when GitHub truncated the tree / `noDeletions` is set. |
| WordPress path deny-list | `enginePolicy.js:15-26`; applied as ship `exclude` in `delivery/wordpress.js:33-35,103-122` | Writing `wp-config.php`, `.env`, `wp-content/uploads`, cache/upgrade dirs, `.git`, `.morpheus/(secrets\|billing)`. Applied before a branch is even created. |
| WordPress tenant rails | `lib/tenantPolicy.js`; used `wordPressDeploy.js:28,55,97-98` | `force` for non-admins (`forceAllowed`), >20 ops/hour (`assertWithinVelocity`), pushing to a repo the tenant's token can't push (`assertRepoAllowed`). |
| Merge-on-green | `engine/merge.js:36-58` | Merging with failed/pending checks or a conflicted PR. `force` overrides. 90s grace before "no checks" counts as passing (line 14,44-46). |
| Rollback head check | `github.js:537-539` | Reverting a commit that is no longer the branch head (would silently discard newer work). |
| Migration additive-only allowlist | `selfDevMigrations.js:25-48` | Auto-applying `DROP`/`RENAME`/`ALTER COLUMN` DDL — those are reported `needs-manual` instead. |
| Diagnostic tool rails | `selfDevTools.js:47-48,209-275` | Writes via the AI SQL tool (SELECT/WITH only, single statement, 200-row subquery cap, 15s timeout); arbitrary shell on the prod container (`run_command` runs on an ephemeral GitHub Actions runner); screenshots outside `morpheus.nz`. |

---

## 4. Admin-only functions

**Route-level** (`routes/functions.routes.js:50`, `ADMIN_FUNCTIONS`) **and** in-handler, for the self-dev set:

| Function | In-handler gate |
|---|---|
| `importSelfDevRepo` | line 43 |
| `pushSelfDevToGithub` | line 65 |
| `verifySelfDev` | line 36 |
| `mergeSelfDevPr` | line 81 |
| `smokeCheckSelfDev` | line 32 |
| `revertSelfDevPush` | line 35 |
| `applySelfDevMigrations` | line 86 |
| `generateSelfDevManual` | line 145 |
| `generateSelfDevPrototype` (not in your list) | line 44 |
| `buildDeckWidget` (not in your list) | `resolveSelfDevActor` requires admin owner, `buildDeckWidget.js:42-47` |

**Not admin-only** — no in-handler role check and absent from `ADMIN_FUNCTIONS` (any authenticated user, ownership-scoped to their own project):
- `planSelfDevFeature.js` (handler lines 88-93; only requires `projectId` + a ≥10-char goal; project lookup at line 27-30 is `created_by_id: user.id`).
- `getSelfDevFeatures.js:9-14`, `getSelfDevDecisions.js:8-13`, `updateSelfDevFeature.js:22-24,93-97`.

`chatWithMorpheus` is **not** in `ADMIN_FUNCTIONS` — it is shared by every project type and gates self-dev only by the in-handler check at `chatWithMorpheus.js:578`.

---

## 5. Gaps / risks I can cite

1. **Declared policy fields are largely unenforced.** `enginePolicy.js:6-8` says so itself ("Nothing enforces the whole of this yet"). Only `denyPaths` and `allowPathPrefixes` are enforced by `assertWritable` (`enginePolicy.js:99-123`); `tenantPolicy.js` enforces `allowForce`, `maxTurnsPerHour`, and `repoAllowList` — and is only wired into the **WordPress** path (`wordPressDeploy.js:28,55,97-98`). `allowDirectToMain`, `allowMigrations`, `allowInfraWrites`, and `maxSpendPerDayUsd` are not read anywhere on the self-dev path.
2. **`pushSelfDevToGithub` accepts `body.force` unconditionally.** Lines 76-90 turn `force` into both a verify bypass and `directToMain`, with no `allowForce`/`allowDirectToMain` policy check. It is admin-gated, so currently only admins; `buildDeckWidget.js:251-253` only *relies* on never passing it, not on enforcement.
3. **`buildDeckWidget` is route-admin-only today because it "isn't yet the real, guarded caller"** (`functions.routes.js:44-49`). That comment says to remove the gate once Phase 3 lands; at that point a non-admin-triggered widget build reaches `pushSelfDevToGithub` under an elevated admin actor (`buildDeckWidget.js:234`).
4. **H9's root-cause check is bypassed by `force`/`directToMain` and by any scoped push** (`selfDevDrift.js:71,75`), leaving only the >10-deletion net — which is also skipped for scoped pushes. Intentional per the comments, but it means the sync-point check is not a universal guard.
5. **The H9 root-cause check degrades to the deletion-shape net** when `Project.synced_commit` is absent (`selfDevDrift.js:102-108`; `importSelfDevRepo.js:148-155` tolerates the missing column). Whether the `selfdev-add-synced-commit.sql` migration has been applied in production determines whether the primary check is live.
6. **`resolveSelfDevActor` picks any `self_dev` project, not the caller's** (`buildDeckWidget.js:42-47`), and uses its owner as the privileged actor.
7. **Self-dev rollback has no explicit deploy trigger** — it relies on Northflank/Netlify watching `main` (`delivery/selfDev.js:101-111`), unlike the WordPress adapter which calls `triggerDeploy` (`wordpress.js:139-150`).
8. **`wordPressDeploy`'s `dry_run` uses the `precheck` callback to abort** (`wordPressDeploy.js:71-94`) — safe because `ship.js:106-109` returns before any branch/commit, but it is an abort-by-side-channel rather than a distinct no-write path.

---

## 6. Unknowns (not verified here)

- Frontend wiring (`src/pages/SelfDev.jsx`, `AdminPanel.jsx`) for FORCE / MERGE ANYWAY / SYNC buttons and PR poll cadence — only referenced from server comments.
- Whether `selfdev-add-synced-commit.sql`, `add-self-dev-features-table.sql`, and `add-self-dev-decisions-table.sql` are applied in the live DB.
- `routes/admin.routes.js` buttons for manual regen / apply-migrations / rollback picker.
- The WordPress plugin's PHP side (separate codebase) — the deny-list is *also* claimed to be enforced there (`wordpress.js:10-14`).
- Whether `chatWithJarvis.js` can currently reach `buildDeckWidget` (it is described as "not yet the real, guarded caller", `functions.routes.js:47-49`).
- Runtime behavior of any of the above; this was a static read only.
