# Self-dev lifecycle and the shared delivery engine

Provenance note: written from **direct source review** at commit `509d2ce` (2026-09-19), not from
the audit — the audit artifact for this area was lost to a harness truncation. Line numbers are from
that commit; re-grep before editing.

## What self-dev is

Morpheus develops **itself** through a mirror of its own production repo held as `ProjectFile` rows:

- Fixed target (`server/src/lib/selfDevRepo.js:15-18`): `SELF_DEV_OWNER = 'robmitchellengineering-hub'`,
  `SELF_DEV_REPO = 'morpheus-self-hosted'`, `SELF_DEV_BRANCH = 'main'`.
- Workspace: a singleton, admin-only `Project` with `project_type: 'self_dev'`
  (`importSelfDevRepo.js:73-87`). `generateSelfDevManual.js`, `pushSelfDevToGithub.js`,
  `revertSelfDevPush.js`, `smokeCheckSelfDev.js` and `buildDeckWidget.js` all find it by
  `project_type: 'self_dev'`.
- `Project.synced_commit` records the branch HEAD the mirror was last synced from, or successfully
  pushed/merged to (nullable; added by `selfdev-add-synced-commit.sql`).

Self-dev functions are admin-only **twice over**: their names are in `ADMIN_FUNCTIONS`
(`server/src/routes/functions.routes.js:50`) and most handlers also start with
`if (user.role !== 'admin') throw ... 403`, so a widget or device token can never reach them even
when the owner is an admin.

## The shared engine (`server/src/lib/engine/`)

Host-agnostic: any GitHub-repo target can use it. Self-dev is its first caller; the WordPress
adapter reuses parts of it.

**`engine/verify.js` — `verifyProject(files, { exclude, entryPoints, esbuildPlugins })`** runs three
deterministic checks (verify.js:6-13): (1) a per-file transform via `checkSyntax`
(`lib/syntaxCheck.js`), catching syntax/JSX errors (:66-69); (2) a real esbuild bundle from the
entry points with `packages: 'external'` so npm deps are not resolved and only local files are
bundled (:71-105) — defaults from `DEFAULT_ENTRY_POINTS` (:32-36) are `src/main.jsx` (browser,
alias `@`→`src`), `server/src/index.js` and `server/src/worker.js` (node); asset extensions map to
the `empty` loader, and an entry absent from `files` is skipped; (3) a cross-file named-export check
via `findBrokenImports` (`lib/importGraph.js`, :110-118) — the H1 class. It returns
`{ok, errorCount, errors, checkedFiles}`, errors deduped and capped at 50 with
`{phase, file, line, column, text}`. It deliberately does **not** run `vite build` or `eslint` —
the backend container has neither.

**`engine/ship.js` — `shipChange(token, repoFullName, opts)`** reads the remote recursive tree once,
then: diffs by git-blob SHA so an unchanged file is never re-pushed (:81-87); counts a remote path
absent from `files` as a deletion **only if `exclude(path)` is false**, skipping deletions entirely
when GitHub truncated the tree (`treeTruncated`, :77, :89-95) — the H7 guard; returns
`{shipped:false, reason:'no-changes'}` for an empty diff (:102-104); runs the optional
`precheck({changedPaths, deletePaths, createCount, updateCount})` after the diff and before the
push, where **any non-null return blocks the ship** and is spread into `{shipped:false, ...block}`
(:106-109) — every self-dev gate that needs diff facts lives here. Everything goes out as **one
commit** (:5-16). `directToMain: true` pushes straight to `baseBranch` (:115-125); otherwise it
creates `${branchPrefix}${timestamp}` and opens a PR via `createPullRequest`, passing `incremental`
through for large repos (a full WordPress install 500s the tree endpoint). `noDeletions` exists for
a caller whose `files` is a subset rather than a mirror.

**`engine/merge.js` — `mergePrWhenGreen(token, repoFullName, prNumber, { force, commitTitle })`**
polls combined check state (:30): already merged → `{merged:true, alreadyMerged:true}` (:32-34);
`failed` → the failing check names, base branch untouched (:37-39); `pending` → poll again (:40-42);
`passing` with no checks and a PR younger than `NO_CHECKS_GRACE_MS = 90000` → still pending, so
"no checks yet" is not mistaken for "passing" (:14, :44-46); not mergeable → `conflict` with a
sync-and-re-apply message (:47-49); `force: true` (the page's MERGE ANYWAY) skips all of that. The
merge is `method: 'squash'` and the branch is deleted best-effort (:52-63). GitHub-native
auto-merge and branch protection are unavailable on a private free-plan repo, which is why this
poll-and-merge exists at all.

### Delivery adapters (`server/src/lib/delivery/`)

`index.js` defines the contract (`id`, `label`, `describe()`, `verify`, `ship`, `merge`,
`rollback`, `healthCheck`), registers `selfDevDelivery` and `wordpressDelivery`, and exposes
`getDeliveryAdapter(id)` (400 on unknown) plus `deliveryIdForProject(project)` — `'self-dev'` for
`project_type === 'self_dev'` and **null** for everything else, because a plugin tenant's adapter is
resolved from its connection, not the project row (:39-45).

`delivery/selfDev.js` (`id: 'self-dev'`) reports `previewKind: 'netlify-deploy-preview'`,
`shipKind: 'pr-auto-merge'`, `deployKind: 'northflank-auto'`, `rollbackKind: 'tree-revert'`
(:34-46). Its `verify` passes `exclude: shouldExclude`, the default entry points, and an
`externalBase44` esbuild plugin that marks `base44/` imports external — `base44/` is excluded from
the workspace but a few frontend files import from it, so without the shim verify reports a
false-positive unresolved import (:19-28, :51-57). Its `ship` calls `shipChange` with
`exclude: (p) => shouldExclude(p) || (scopeExclude ? scopeExclude(p) : false)`,
`baseBranch: SELF_DEV_BRANCH`, `branchPrefix: 'self-dev/'`, label `Self-dev` (:83-95). Its
`rollback` calls `github.js revertCommit`, which points main at the tree from just before that
commit as one new commit and **refuses if the branch head has moved** (:97-111). Its `healthCheck`
black-box probes production (:113-133): `GET ${BACKEND_PUBLIC_URL|https://api.morpheus.nz}/api/health`
expecting `morpheus-server`, `GET /api/auth/me` expecting 401,
`POST /api/functions/browseTemplates` expecting 200, and `${first CORS_ORIGIN|https://morpheus.nz}/`
expecting `id="root"`; failing names feed the same auto-diagnose flow a failed deploy does.

`delivery/http.js` provides the `probe` helper. `delivery/wordpress.js` is the second adapter
(reuses merge/rollback, brings its own verify entry points, webhook+PHP ship and healthCheck). The
self-dev function handlers keep only the admin gate and side effects (chat note, usage log, decision
stamp, manual regen, migration apply) and delegate the mechanism to the adapter.

## Engine policy (`server/src/lib/enginePolicy.js`)

Three frozen policy objects decide what a caller of the engine may do; fields are additive caps and
absent/false means not allowed (enginePolicy.js:28).

| Policy | force | direct to main | migrations | infra writes | path rule | caps |
| --- | --- | --- | --- | --- | --- | --- |
| `ADMIN` (self-dev) | yes | yes | yes | yes | no deny list, no allow-list cap | unlimited turns/spend, any repo |
| `PLUGIN_TENANT` | no | no | no | no | `PLUGIN_DENY_PATHS` deny list | 20 turns/hr, $25/day, repos the tenant token can push to |
| `WIDGET_BUILD` | no | no | no | no | narrow **allow**-list | 20 turns/hr, $25/day |

`PLUGIN_DENY_PATHS` (:15-26) is a security boundary: `wp-config.php`, `.env*`,
`wp-content/uploads/`, `wp-content/{cache,upgrade,upgrade-temp-backup,wp-rocket-config}/`, `.git/`,
`.morpheus/{secrets,billing}`. `WIDGET_BUILD.allowPathPrefixes` (:79-83) allows only
`^src/pages/CommandDeck/widgets/`, `^server/src/functions/widget[A-Z]`, and exactly
`^src/pages/CommandDeck/deckWidgets\.js$`; it deliberately does not restrict what a built widget's
own code may *call* at runtime, only which files the build may edit.

- `assertWritable(policy, path)` (:99-123) throws 403 with `code` `POLICY_DENY_PATH`,
  `POLICY_OUTSIDE_SCOPE` or `POLICY_DENY_INFRA`. A non-empty `allowPathPrefixes` inverts
  `denyPaths`: everything not matching is denied, and an allowed path short-circuits the generic
  infra-write check. `partitionWritable` returns `{allowed, denied}` without throwing.
- `scopeExcludeFor(policy)` (:148-152) is the ship-compatible mirror — true for any path the policy
  does not allow, and `() => false` for an unscoped policy (`allowPathPrefixes: null`).
  `resolvePolicy(id)` accepts a registered id or a raw ad-hoc policy object.
- The file's own header says "Nothing enforces the whole of this yet" (:7). What enforces the caps at
  runtime is `server/src/lib/tenantPolicy.js`: `policyIdForUser` (`'admin'` iff `role === 'admin'`),
  `forceAllowed`, `assertWithinVelocity` (429 `POLICY_VELOCITY` at `maxTurnsPerHour`, a no-op for an
  infinite cap), and `assertRepoAllowed` (403 `POLICY_REPO`, checking `permissions.push` for
  `'token-push-access'`). `applyFileOperations(..., policy)` calls `assertWritable` before any DB
  write (`lib/projectUtils.js:157`, `:167-174`), recording `policy_denied`, wired from
  `chatWithMorpheus.js:771` and passed at `:1600`.
- Still only declarative in `enginePolicy.js`: `allowMigrations` and `maxSpendPerDayUsd`.

## Lifecycle

**Sync** — `importSelfDevRepo.js` reads the remote tree, fetches only blobs whose remote SHA
differs from the local one (:87-98), upserts `ProjectFile` rows, removes local files deleted
upstream, then records `Project.synced_commit = headCommit` from the branch **ref** (not the tree,
whose sha is a tree sha) and warns if the column is missing (:57-62, :145-153).

**Verify** — `verifySelfDev.js` `runVerifySelfDev(user)` loads the workspace and calls the adapter's
`verify`; 404 with no self-dev project, 400 with an empty workspace. Logs `self_dev_verify`. The
same function is the push gate.

**Ship** — `pushSelfDevToGithub.js` (gates below). Direct mode: chat note, `logUsage('self_dev_push')`,
`stampDecisionRef`, `synced_commit = commitSha`, manual regen if a manual source changed, then apply
migrations if the change touched `schema.prisma` or a `selfdev-*.sql`. PR mode: chat note with the
PR URL, usage, decision stamp, and returns
`{prNumber, prUrl, branch, headSha, touchedManualSource, hasMigration}` for the page to poll.

**Merge** — `mergeSelfDevPr.js`; on a real merge it writes the chat note, logs
`self_dev_pr_merge`, records `synced_commit = mergeCommitSha`, and regenerates the manual / applies
migrations when the caller says so.

**Smoke** — `smokeCheckSelfDev.js` runs the adapter's `healthCheck` on the real just-deployed URLs
after the deploy watcher flips to `deployed`; logs `self_dev_smoke`.

**Revert** — `revertSelfDevPush.js` validates `commitSha` against `/^[0-9a-f]{7,40}$/i`, calls the
adapter's `rollback`, logs `self_dev_revert`, and drops a dated, unfilled incident stub into the
workspace's `KNOWN-HAZARDS.md` via `appendHazardStub` (best-effort).

**Auto-diagnose** — `src/hooks/useDiagnosis.js` invokes `diagnoseIssue` with
`{type: 'deploy'|'compile'|'github'|'build', projectId, errorContext}` and returns
`{summary, autoFixed, needsUserAction, totalErrors, allClear}`; `diagnoseIssue.js:37-46` dispatches on
`type`. A failed smoke check instead prompts the AI in chat to add the root cause to
`KNOWN-HAZARDS.md` (`src/pages/SelfDev.jsx:383`).

## Supporting subsystems

- **Feature lifecycle** (`SelfDevFeature`): `planSelfDevFeature.js` allows one active feature per
  project (409 otherwise), requires 3-8 steps, and 503s pointing at
  `server/prisma/add-self-dev-features-table.sql` when the table is missing.
  `updateSelfDevFeature.js` supports `completeStep|reopenStep|setSteps|abandon|complete`, caps
  `setSteps` at 12, and 404s on a feature the caller does not own. `lib/selfDevFeature.js` holds
  `parseSteps`/`normalizeSteps`/`hydrate` (exposes `scopePolicy`)/`createFeature`/`getActiveFeature`/
  `featureContextBlock`.
- **Decision log** (`SelfDevDecision`): `lib/selfDevDecisions.js` `recordDecision`, `stampDecisionRef`
  (stamps rows whose `ref` is null), `recentDecisionsBlock`. Every push and merge stamps the 7-char
  SHA or `PR #<n>`.
- **Manual regeneration**: `generateSelfDevManual.js` exports `SELF_DEV_ADMIN_MANUAL_SOURCES`
  (11 files) and `runGenerateSelfDevManual(user, trigger)`: sha256 the concatenated source →
  `invokeAI` (planner, 20000) → upload markdown → store the singleton `SelfDevManual` with a
  2000-char preview.
- **Prototype generation**: `generateSelfDevPrototype.js` caps `MAX_FILE_SIZE = 8000` and
  `MAX_FILES = 12`; on `OUTPUT_TRUNCATED` it returns `{html: '', truncated: true}` instead of throwing.
- **Diagnostic tools**: `lib/selfDevTools.js` is the read-mostly tool registry for self-dev turns
  (read logs, read-only SQL via `READ_SQL = /^\s*(SELECT|WITH)\b/i` capped at 200 rows, a screenshot).
  `chatWithMorpheus` runs at most 3 per round for at most 2 rounds.
- **Migration runner**: `applySelfDevMigrations.js` `runApplySelfDevMigrations(user, {projectId,
  dryRun})` reports per file one of `already-applied`, `empty`, `needs-manual`, `pending`, `applied`,
  `failed` and returns `{results, applied, failed, manual, pending}`.
- **GitHub layer** (`server/src/lib/github.js`, 889 lines): `getGithubToken(userId, {projectId})`
  prefers a per-project `Project.github_token`, else the user's OAuth connection, and throws 400
  `GitHub not connected …` when neither exists — there is **no** `GITHUB_TOKEN`/PAT env fallback.
  `pushFiles` has three modes: incremental (one Contents-API commit per file, no deletions),
  new-empty-repo bootstrap, and the default tree rebuild that merges files in code and POSTs a tree
  with no `base_tree`. `deleteFile` requires the SHA to avoid racing a concurrent edit.

## Direct vs PR mode

`directToMain = !!force || body?.directToMain === true` (pushSelfDevToGithub.js:90). Default is
PR mode: push to `self-dev/<timestamp>`, open a PR, Netlify builds a deploy preview as a second
gate, and `mergeSelfDevPr` squash-merges once green. `force` overrides **both** the verify gate
and the direct-to-main choice, so "force" means "skip verification and commit to main".

## Scoped vs unscoped pushes

- **Unscoped** (Rob's own push): no `scopePolicy` in the body → `scopeExclude` undefined → full-repo
  diff and deletion computation, as before.
- **Scoped** (`buildDeckWidget` passes `scopePolicy: 'widget_build'`; `deleteDeckWidget` passes an
  ad-hoc `{id: 'widget_delete', widgetKey}`): `resolvePolicy` → `scopeExcludeFor(policy)` makes every
  path outside the policy's allow-list **structurally invisible to the diff and deletion
  computation**, independent of local workspace freshness (pushSelfDevToGithub.js:92-100) — the
  second half of the H9 defence for scoped builds.
- The one shared file a scoped push may touch, `DECK_WIDGETS_REGISTRY_PATH =
  'src/pages/CommandDeck/deckWidgets.js'`, is diffed normally, so its new content is compared against
  the file's **live remote** content rather than the possibly-stale local copy. A build must satisfy
  `isAppendOnlyDiff` (reason `deckwidgets-not-additive`); a delete must satisfy
  `isSingleLineRemoval(old, new, widgetKey)` (reason `deckwidgets-not-pure-removal`)
  (pushSelfDevToGithub.js:132-154; `lib/selfDevRepo.js:54-77`).

## Every safety gate, and what it prevents

| Gate | Where | Prevents |
| --- | --- | --- |
| Admin gate (route + handler) | `ADMIN_FUNCTIONS` functions.routes.js:50, plus `user.role !== 'admin'` → 403 in each handler | any non-admin or scoped token, and module-level invocation bypassing the route |
| esbuild verify gate | pushSelfDevToGithub.js:75-86 via `verifySelfDev` | syntax/JSX errors, unresolved local imports, and the H1 "does not provide an export named X" class |
| `shouldExclude` + exclusion-gated, truncated-tree-safe deletions | selfDevRepo.js:39-48; engine/ship.js:89-95 | mirroring or deleting `node_modules/`, `.git/`, `dist/`, `coverage/`, `base44/`, lockfiles or binaries, and a subset mirror making the rest of the repo look deleted (H7) |
| H9 drift guard | `evaluateDrift` via precheck, pushSelfDevToGithub.js:104-119 | a stale workspace deleting whatever landed upstream since its last sync (H9) |
| Schema-needs-migration | pushSelfDevToGithub.js:121-130, reason `schema-no-migration` | shipping `schema.prisma` changes with no `selfdev-<slug>.sql` (H8) — **not enforced on the direct-to-main path** |
| `deckWidgets.js` append-only / pure-removal | pushSelfDevToGithub.js:138-154 | a scoped widget build or delete taking another widget's registry entry with it |
| `assertWritable` per op | `applyFileOperations` with `engineScopePolicy` (projectUtils.js:167-174) | a build writing outside its policy allow-list (`policy_denied`); the adapter contract applies the same check to non-chat writes |
| Resync-before-build | `buildDeckWidget.js:159-164`, `deleteDeckWidget.js:90-95` | an automated widget build pushing from a never-synced or stale workspace |
| Path deny-list | `PLUGIN_DENY_PATHS` | a plugin tenant overwriting credentials or wiping the media library |
| Tenant velocity cap / repo allow-list | `tenantPolicy.assertWithinVelocity`, `assertRepoAllowed` | a scripted loop draining a balance; a tenant targeting a repo its token cannot push to |
| Revert-head-moved | `github.js revertCommit` (409) | reverting a commit that is no longer head |

There is **no secret scanning anywhere** in the push, verify or ship path (no
`scanForSecrets`/`SECRET_PATTERNS`-style helper exists in `server/src`), and no explicit
"dirty workspace" check — the workspace is intentionally mutable and the only staleness gate is H9.

## The H9 drift guard (`server/src/lib/selfDevDrift.js`)

`shipChange` diffs the local mirror against the **live** remote tree and treats every remote path
absent locally as a deletion, so a stale workspace does not merely miss upstream work — it deletes
it. Incident H9 (2026-09-11) removed ~45 files including the shipped `blockWidget` security fix.

`evaluateDrift({syncedCommit, remoteHead, deleteCount, scoped, directToMain})` is pure (no I/O, no
Prisma) and returns `null` to allow or `{reason, message}` to refuse (selfDevDrift.js:67-91):
`directToMain` → allow (explicit operator override, matching the schema gate's `force`); `scoped` →
allow (a scoped push structurally cannot diff outside its allow-list);
`syncedCommit && remoteHead && syncedCommit !== remoteHead` → `{reason: 'stale-workspace'}`, whose
message names both 7-char SHAs, cites H9, and tells the operator to SYNC FROM GITHUB and re-apply or
push with force; and independently `deleteCount > MAX_UNSCOPED_DELETIONS` (10) →
`{reason: 'excess-deletions'}` (normal changes delete 0-3 files; H9 deleted ~45). Either way the block
is returned by the ship `precheck`, so it is a **block, never a silent rewrite**
(pushSelfDevToGithub.js:117-119).

`readSyncedCommit` and `readRemoteHead` degrade to `null` on any failure, including the
`synced_commit` column not existing yet (`isMissingSyncedCommitColumn`), leaving the deletion-shape
half as the only check rather than blocking a legitimate push. Coverage:
`scripts/verify-drift.mjs` (19 assertions, including an H9 replay).

## Admin-only self-dev functions

`ADMIN_FUNCTIONS` (functions.routes.js:50), of which these are the self-dev family (all of them
also re-check admin inside the handler unless noted): `importSelfDevRepo`, `pushSelfDevToGithub`,
`generateSelfDevPrototype`, `generateSelfDevManual`, `verifySelfDev`, `revertSelfDevPush`,
`mergeSelfDevPr`, `smokeCheckSelfDev`, `applySelfDevMigrations`, `buildDeckWidget`. The other two
entries are `synthesizeUpdatesPlan` and `generateRebuildDoc`. `chatWithMorpheus` is deliberately
**not** in the set — it is shared by every project type, so its self-dev path is admin-gated
inside the handler instead.

## Known discrepancies and risks

- **`AGENTS.md:23` says "Migrations in `server/prisma/migrations/`".** No such directory exists
  (see `data-model.md`). The DB is migrated by hand-run SQL.
- **H8 gate hole:** the schema-needs-migration block is skipped when `directToMain` is true
  (pushSelfDevToGithub.js:123) and the `ADMIN` policy sets `allowDirectToMain: true`
  (enginePolicy.js:33), so an admin `force` push can ship a schema change with no migration.
- **Migration apply can fail silently after a successful push/merge:** pushSelfDevToGithub.js:215
  and mergeSelfDevPr.js:71 log `migration apply failed (push succeeded)` / `(merge succeeded)`, so
  code can be live against an un-migrated schema.
- **`KNOWN-HAZARDS.md`'s header claims new incidents are appended by "the deploy-failure
  auto-diagnose flow".** In source the only programmatic append is
  `revertSelfDevPush.appendHazardStub`; the smoke-failure path only *asks the AI in a chat prompt*
  to add it (`src/pages/SelfDev.jsx:383`). Treat the header as aspirational, and note H9's own text
  still calls the drift guard "not yet built" even though `lib/selfDevDrift.js` now ships it
  (commit `7374156`).
- **H2 is still live:** `generateSelfDevManual.js:87` filters
  `projectFile.findMany({where:{created_by_id: user.id}})` even though `scope()` already lets
  admins see all rows.
- **`force` is broad.** It disables verification, chooses direct-to-main, and bypasses the drift
  guard and the schema gate — four protections behind one flag.
- **`enginePolicy.js` is only partly wired.** Its `allowMigrations` and `maxSpendPerDayUsd` have no
  enforcement site; the caps that *are* enforced live in `lib/tenantPolicy.js`.

## Open questions

- Whether `Project.synced_commit` / `server/prisma/selfdev-add-synced-commit.sql` has actually
  been run against production. Until it is, the drift guard's root-cause half degrades to the
  `>10 deletions` half (the commit message says so explicitly).
- Whether the `wordpress` delivery adapter is reachable in production; `deliveryIdForProject`
  returns `null` for every non-self-dev project, and its ship/healthCheck paths were not traced.
- Which Deploy watcher interval and UI polling cadence drive `mergeSelfDevPr` / `smokeCheckSelfDev`
  from `src/pages/SelfDev.jsx`; not traced in this review.
- Whether `allowDirectToMain` was intended to be exercisable by anything other than an admin `force` push.
