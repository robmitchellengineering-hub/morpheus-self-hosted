# KNOWN HAZARDS

Self-inflicted breakage that has already happened to this codebase, so it
doesn't happen again. **Self-dev's planner and reviewer are given this file on
every build turn** — the reviewer must check each proposed change against every
item here and flag a violation as a **critical** issue.

One thing appends here automatically, and it is only a placeholder:
`revertSelfDevPush` writes a stub when it reverts a push, and filling in the root
cause is a job for a human or an agent — the deploy-failure auto-diagnose flow
does **not** write to this file, whatever an earlier version of this header
claimed. That stub is also fragile: it is appended to self-dev's own `ProjectFile`
mirror, so it reaches the repo only on the *next* push, and is destroyed if that
push is reverted. The only `## Incident` stub ever written here was lost exactly
that way. When you fix a production break, add the root cause here as part of the
same change.

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

**There are TWO SQL files, and a new model needs both.** The migration above is
what *production* runs; `server/prisma/manual-supabase-init.sql` is what a
**fresh install** runs, and it holds its own `CREATE TABLE` / index / foreign key
for every model. Shipping one without the other is invisible in production and
leaves every new self-host a lesser install. `scripts/verify-bootstrap-sql.mjs`
counts them against the schema. (2026-10-02: the two `deck_play_*` models shipped
with their `add-deck-play.sql` migration and nothing in the bootstrap — 55 tables
against 57 models. Caught by the guard, in the full suite.)

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
session active on the same repo.

The longer-term fix this entry used to describe as outstanding is **built**:
`server/src/lib/selfDevDrift.js` compares the push's target base against `main`'s
actual HEAD and refuses a push whose diff implies remote drift, instead of
silently reverting toward a stale snapshot. `verify-drift.mjs` asserts it, and
`Project.synced_commit` is what it compares against. Two things it does *not*
cover, and both stay the operator's job: a push with `force`/`directToMain`
bypasses the check, and so does a scoped push (see
`docs/audits/selfdev-pipeline-audit.md`).

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

## H12 — a wrong relative import passes every gate, then kills the container at boot

**Incident (2026-09-19, ~46 minutes of API downtime):**
`server/src/lib/deckInsightSchedule.js` was written by mirroring
`server/src/freshnessSchedule.js`, and the import came across verbatim as
`./queue.js`. That is correct from `src/`, but this file lives in `src/lib/`, so
it resolved to `src/lib/queue.js` — a file that does not exist. The real one is
`server/src/queue.js`, so the specifier needed `../queue.js`.

`index.js` imports that module at boot, so the process died at module load.
Northflank had zero healthy instances and **every** API request returned
`503 no healthy upstream` from `istio-envoy`. The frontend stayed up, which is
what made it read as a backend-only failure.

**Why every gate was green — this is the point of the hazard:**

- CI ran `node --check` over every server source. That validates **syntax** and
  never resolves an import specifier; a wrong path is syntactically perfect.
- `npm run lint` does not resolve them either.
- The integration tests imported `deckInsight.js` directly, so they never loaded
  `deckInsightSchedule.js` and never traversed the broken edge. Testing a module
  is not testing everything that imports it.
- It was never booted locally after the scheduler was registered. The one
  attempt used `timeout`, which **does not exist on macOS**, so the command
  failed before `node` ever ran — a "no output" that looked like a pass.

**Rule:** a new module in the server tree is not verified until something has
actually **loaded** it. `scripts/verify-server-imports.mjs` now resolves every
relative specifier in `server/src` and `server/scripts` with exact case, and CI
runs it in the guards job. Case is checked because macOS is case-insensitive
while the Alpine container is not, so `./DeckMemory.js` for `deckMemory.js`
works locally and dies in production.

Two corollaries worth keeping:

- **Prefer booting over inspecting.** `NODE_ENV=production node src/index.js`
  plus an `/api/health` request would have caught this in seconds. Do that after
  registering anything new in `index.js` or `worker.js`.
- **Never trust a command that failed to run.** `timeout` not existing produced
  the same empty output as a clean run.

## H13 — an external query can succeed, return nothing, and stay that way forever

**Incident (2026-09-17, commit `6dc8c1e`):** the Gmail inquiry sync filtered on
`category:primary` with no date bound. That query returns **zero messages, ever**
— so the sync logged success on every run since the feature shipped and dropped
every real inquiry that ever arrived. It was not a classifier miss: the messages
were never fetched, and nothing anywhere said so. H10 covers a 404 from an
endpoint that does not exist; this is the quieter shape — a `200` with an empty
set.

**Rule:** before shipping a feature that depends on an external query, prove that
the query returns **non-empty against a known-populated account**. "The call
succeeded" is not evidence that it returned anything. A filter you have not seen
return a row is a filter you do not yet know works.

## H14 — a green build can ship an artifact that cannot run

**Incident (2026-09-20, commit `2bc0a05` and the fixes around it):** a class of
compile failures that each report **success**:

- `pip3 install -r requirements.txt … || true` with no venv — on Raspberry Pi OS
  Bookworm (PEP 668) pip aborts with `externally-managed-environment`, `|| true`
  eats it, and the workflow passes while releasing an image whose service
  crash-loops on first boot.
- PowerShell array splatting passes each element as **one** argv entry, so
  PyInstaller receives the literal token `--add-data "templates;templates"` and
  argparse cannot split it on the space.
- An artifact lookup keyed on the *project* rather than the *build* means every
  recompile silently keeps serving the first build ever saved.
- Buffering a compiled artifact in memory produced 3 backend crash-restarts in a
  47-minute window with no app-level error — a hard OOM kill.

**Rule:** never `|| true` a dependency install, and never let a step's exit code
be the only evidence it worked. `node scripts/compile-smoke.mjs` runs the real
workflow on GitHub Actions and reports the runner's own conclusion — a paper
audit of the adapters came up clean twice while `python-package` was failing on
every run.

## H15 — a shared module can lose its *behaviour* and pass every gate

**Incident (2026-09-13/14, commits `1891ae6` and `4e8ed1e`, both reverted; and
`969232a`):** `server/src/ai.js` was rewritten from **585 lines to 153** in a
self-dev push, dropping `fetchWithTimeout`, model auto-discovery, the platform
temperature override, `reserveCredits`/`reconcileCredits`, the provider-balance
fallback and truncation handling — with `node --check`, lint and build all
green, because none of them read behaviour. It happened twice and the revert
messages never recorded why.

The same emergency revert deleted `server/src/lib/errorLogger.js` as **named
collateral** — the secret-redacting `logError` / `sendError` helper, wired into 46
call sites across 7 route files — and it was never restored. Six of the seven
route files still log nothing at all, so a route handler can answer `500` without
recording anything anywhere. (The other collateral from that revert, the Alice
stats work, *was* redone.)

**Rule:** H1 covers dropping an **export**; this is the case where the shape is
untouched and the substance is gone. When a shared module changes, diff what it
*does*, not only what it exports — and read a deleted `// WHY` comment as the
signal that a behaviour left with it. No guard sees this yet; review it by eye.

## H16 — an admin-scoped read can expose another account's private data

**Incident (2026-09-17, commit `71c6bbd`):** `scope()` lets admins see all rows.
Rob is the platform's only admin, so his own `/deck` silently merged **another
account's** Deck rows — tasks, brain-dump items, widget preferences — into his
view. Private data crossed accounts and nothing failed; the pages simply showed
more than they should. The fix is now the standing own-data rule in the
`morpheus-deck` skill, but the incident itself had no number.

**Rule:** for any personal-data model (`Deck*` especially), an admin-scoped read
must be a deliberate, explicit widening — never the default that `scope()`
happens to produce. Assert that `scope()` cannot return another account's rows
for these models, and treat "the admin can see everything" as a disclosure
decision, not a convenience.

## H17 — a check that never ran reads as a check that passed

**Incident (2026-09-20, PRs #258 and #259):** GitHub does not create a
`pull_request` workflow run when it cannot compute the merge commit, and it never
backfills the run once mergeability resolves. Both PRs were opened in that state:
every check on them was a Netlify deploy preview (two of them reported
`skipped`), all green, and **no CI run existed at all** — no `guards (no
install)`, no `lint + build`. `getPullRequestChecks()` asks "did anything fail?",
so its answer was `passing`, and `engine/merge.js`'s "no checks yet" grace did not
apply either, because checks *did* exist — just not the ones that verify the code.
A green deploy preview would have been the only gate before production, which is
precisely the gap the CI workflow's own header says it was written to close. The
runs appeared only after each PR was closed and reopened.

**Rule:** "nothing failed" is not "the gates ran". A repo whose CI we know must
require its gates **by name, present and successful** — `skipped` and `neutral`
are not passes — with the list living in `engine/requiredChecks.js` and asserted
against the workflow's own job names by `scripts/verify-merge-gates.mjs`, so a
rename on either side cannot silently disable the requirement. A repo with no
known gates keeps the old behaviour, and a conflict is answered as a conflict:
it is the reason the run never appeared. Never let a *host's* green preview stand
in for verification of the change.

**The same shape one level down, and it bit on 2026-10-02: a guard that is not in
CI is a guard that never runs on a PR.** A new guard added to `scripts/verify.mjs`
and nowhere else passes every local suite — including the whole of `verify.mjs` —
while never executing on a pull request, because the workflow runs each guard as
its own named step. Green locally, absent from the gate. **Adding a guard is a
three-place change:** `scripts/verify.mjs`, a step in
`.github/workflows/ci.yml`, and an entry in the mutation registry
(`scripts/guard-mutations.mjs`, proving it can actually go red — H19). Two guards
now refuse the omission: `scripts/verify-context.mjs` fails a hard gate CI does
not run, and `scripts/verify-guard-mutations.mjs` refuses an unproven one. **Run
the whole suite, not the checks you remember writing** — that run is what caught
this and the bootstrap-SQL gap in H8 above, neither of which appeared in the
hand-picked guards run while writing them.



## H18 — a `try` block hides its own declarations from its sibling `catch`

**Incident (2026-09-27, PRs #356, #358, #360, #361, #362):** `chatWithMorpheus`
declares the turn's build state — `appliedOps`, `reply`, `fullReply`,
`truncatedFiles`, the rework counters — and reads it after the build, both in the
reply building and in the `catch` whose entire job is to hand back a result when
something throws *after* the build already landed. Three refactors in a row
(`dbd73f7`, `67d779e`, `3b72ef1`) moved those declarations *inside* the turn's
big `try` block. `let`/`const` in a `try` block is scoped to that block, so a
sibling `catch` cannot see it, and neither can the code after it.

`#356` put the coder's `chunkOps` there and read it after the block: **every code
build through the chat path died** — the throw landed before the gates and before
apply, so nothing was written and the user got an error, which is the exact
outcome that commit was written to prevent. `#361` hotfixed that one read, and
`#362` then found **16 more in the same file**, including the whole of `#358`'s
recovery path — so the recovery had never once run, and the error it was written
to swallow was thrown again from the `catch` itself.

**Rule:** a declaration that must outlive its block belongs outside it. Before
reading a name in a `catch`, in a `finally`, or anywhere after a `try`, check
that it is not declared inside that block. `no-undef` decides this exactly, which
is why `server/src/**` now has a lint block in `eslint.config.js` — the frontend
had one all along. Note what could not see it: `node --check` passes (valid
syntax), the import resolver passes (the names are local), and the boot smoke
passes because loading a module never calls the function that contains the bug.
Only running the code, or `no-undef`, finds it.

## H19 — a guard can be satisfied by the bug it exists to prevent

**Incident (2026-09-30, PRs #443–#450):** four days of backend-generation work added
six verify guards, and **the same failure appeared in almost every one** — the check
passed while the thing it was written to catch was present. Six recorded instances, each
found by *removing the code under test*, never by reading the guard:

- `verify-usage-observability.mjs` **required** `recordUsageEvent({ model: resolvedModel, ... })`
  in a catch block where `resolvedModel` is declared inside the sibling `try` — so the
  guard demanded the temporal-dead-zone reference error of **H18**, which was replacing
  every provider error in the product with "Cannot access 'resolvedModel' before
  initialization". A guard that pins a bug is worse than no guard, because it feels like
  coverage.
- `verify-backend-chunk-context.mjs` asserted the words *"ONE command must start
  everything"* appeared in `generateBackend.js`. **Deleting the line that injected that
  requirement still passed** — the words survived in a now-unused string.
- The same guard matched the literal `buildPrompt(chunk, cleanPlanned, fileOps.slice())`;
  hoisting that call into a `send(paths)` helper broke the check while the behaviour was
  unchanged.
- A `/usage`-redeems-the-ticket check read the **whole file**, so it was satisfied by the
  identical call in `/refund`.
- `verify-cloud-metering.mjs` matched its own **comment** quoting the thing it forbade —
  and so did `verify-backend-chunk-context.mjs` and `verify-incremental-persist.mjs`.
- `verify-generated-app.mjs`'s `dependencyProblems` took a parsed manifest while the guard
  passed `packageJsonOf`'s `{ path, data }` wrapper, so it reported **no problems** for a
  manifest that declared an unbuildable package. Silent in the dangerous direction.

Measured against this repo: **83 verify guards, 40+ importing a pure `lib/` module, and
none proving it can fail.**

**Rule:** before believing a green check, **break its subject and confirm the check goes
red.** Remove the guard clause, invert the condition, rename the field — one honest
mutation, run the guard, expect a non-zero exit. A guard whose failure cannot be
demonstrated is a comment with a `console.log`. This is the same rule as **H17** ("nothing
failed" is not "the gates ran") applied to the guard itself rather than to CI.

**The mechanical version of this rule is worth building and does not exist yet:**
a registry of one sabotage per guard — `{ guard, file, find, replace }` — plus a runner
that copies the tree to a temp dir, applies the mutation, runs the guard and fails if it
stays green. A mutation that no longer matches should be reported as **stale**, not
skipped silently; a prototype of exactly this found three of the four mutations
load-bearing and flagged the fourth as stale. `scripts/verify-verifier-coverage.mjs` is
the existing precedent — a guard that tests guards — and is the shape to copy.

**Two habits that produced every one of the six:** asserting on a guard's own prose
(always strip comments before matching source — `const code = (src) => …`), and asserting
a *spelling* rather than *behaviour* (call the function and check its return value; do not
grep the file for the words it once contained).

**A third habit, and the one the rule above cannot reach (2026-09-30, #452): check the
FIXTURE as well as the assertion.** `verify-security-posture.mjs` asserted that the
hardcoded-secret check fired for `const K = "this-is-not-a-real-secret-0000"` — a
single-letter identifier, while that check deliberately keys on the *name* a value is bound
to. The assertion was correct; the input could never satisfy it. **Breaking the subject
would not have found this**: delete the check and the guard goes red, keep it and the guard
stays green, and both results are about the fixture rather than the code. A fixture is half
of every assertion — the half that a mutation test cannot see, because it mutates the code
and not the input. Ask instead what the fixture is *for*, and whether it could ever produce
the condition: a guard whose fixture cannot fire is green for a reason unrelated to the
subject.

**And the fixture's VALUE is part of the repository (2026-09-30, same guard, and this one
fails DEPLOYS).** The fixture above originally held a Stripe-shaped `sk-live-…` string.
Netlify's smart detection scans **repository code**, so from the moment that guard landed the
frontend stopped deploying: the build compiled, the scanner refused the deploy, no Netlify
status reached the merge commit, and there was nothing in the application code to find. It
cost an hour of hypotheses about build minutes and Netlify plan limits, and Netlify's own
error template pointed at the wrong thing entirely (`VITE_` variables and
`SECRETS_SCAN_OMIT_KEYS`) because it cannot know *which* string it matched — the answer was
only in deploy-log lines that name the file and line. **A test fixture is committed code, so
it must never be shaped like the thing it is testing for.** Use an obviously fake value:
`this-is-not-a-real-secret-0000` exercises the same regex and cannot be mistaken for a
credential. `scripts/verify-no-secret-fixtures.mjs` fails the build if a tracked file grows a
real-looking one again.

**And the way a check READS THE FILE is part of the check.** The same guard matched the
rules inside the coder's instructions with a lazy `[\s\S]*?`, which scanned **straight out
of one template literal into the next** — so a mutation that moved the rules onto a single
coder branch, leaving the shared instructions bare, still passed. Anchor a class or
literal match to its own delimiters; a lazy quantifier over the whole file is a wildcard,
and a wildcard is how a guard ends up measuring a region nobody chose.

## H20 — a build can only run on the machine that made it, and nothing says which machine that was

**Incident (2026-10-01, Rob: "This app is not suported on this mac").** He compiled the WikiData
Batch Uploader as a **macOS App**, downloaded the disk image Morpheus had just built him, mounted
it, and macOS refused to open the app. Two separate faults, and the second one is the dangerous
one because it makes a *correct* build look broken:

- **The Python path had exactly one runner.** `mac-app` ran on `macos-latest` — Apple silicon —
  and PyInstaller compiles for the machine it runs on. So every Python/Qt app it produced was
  arm64-only, every Intel Mac refused it, and **there was no Intel build to ask for and nothing in
  the product that said so**. The Swift path genuinely cross-builds (`swift build --arch arm64
  --arch x86_64`) and the Node path ships both binaries behind a `uname -m` dispatcher, so this was
  a property of one branch, invisible from the target's own declaration (`runner: 'macos-latest'`).
  The previous fix (`#463`) *reported* the architecture after the fact — a warning in a CI log
  nobody reads, and a line inside the README the user cannot open, being inside the app that will
  not open. Reporting is not shipping an option.
- **GitHub's artifact zip destroys a macOS `.app`.** Before the disk image existed, the build's
  four platform jobs uploaded the raw `.app` as an Action artifact. Downloading it and running it
  gives an instant `SIGSEGV` **before Python starts**: `QtCore.abi3.so`'s static initialiser calls
  `CFBundleCopyBundleURL(CFBundleGetMainBundle())`, and a PyInstaller macOS bundle is held together
  by ~400 **symlinks** (`Contents/Frameworks/QtCore` → `PyQt6/Qt6/lib/QtCore.framework/...`). The
  artifact zip does not preserve them, so the framework is a hard copy, `CFBundleGetMainBundle()`
  returns NULL, and the app dies in `_GLOBAL__sub_I_qdarwinpermissionplugin_location.mm`. Nothing
  about the build changed; the *transport* broke it. Every gate was green, the artifact downloaded
  fine, and the crash report names Qt rather than the zip. (PyInstaller issue #9367; the same
  answer for zip/tar pipelines: `zip -y`, or ship a `.dmg`/`.tar`.)

**Rule: a build target must name the machines its output runs on, and the product must offer one
per machine the user might have.** A `runner` that is a single string silently means "whatever
architecture GitHub gives us today" — so a target that cannot cross-build declares **one runner per
architecture** and the release carries one file per architecture, named for it: `app-macos-intel.dmg`
next to `app-macos-apple-silicon.dmg`. The filename is the only thing a person browsing a release
can go by, so it carries the fact; the release glob, the verify step and the disk image name all
have to agree with it, or the build goes green having published nothing. `scripts/verify-mac-app-arch.mjs`
asserts all of it, and `scripts/mutate-guards.mjs` proves it can fail.

**And: never conclude "the build is broken" from an artifact's behaviour without checking what the
transport did to it.** A zipped `.app` is not the `.app` that was built — the cheap test is
`find TheApp.app -type l | wc -l`, which is zero for a bundle whose symlinks were flattened. Ship
macOS bundles as a `.dmg` (which `hdiutil` writes with symlinks intact) and say so where the
download is offered.

**Corollary, from the same afternoon:** the app had a self-test that could not fail. `core/diagnostics.py`
computed the verdict properly (`selftest_verdict`) and then the `print`/`sys.exit(code)` that used it
sat **after a `return`** — unreachable. Its unit test passed, because it tested the pure function and
never the wiring. A self-test whose failure cannot be observed is H17 with a nicer name.

## H21 — a save that fails can read as a build that failed

**Incident (2026-10-02, the WikiData Batch Uploader's macOS build).** The build **SUCCEEDED** — release
`v36970869714` published `app-macos-apple-silicon.dmg` (103,456,328 bytes), `app-macos-intel.dmg`
(113,581,692 bytes) and `USER-MANUAL.txt` (25,553 bytes). The UI reported:

> "Build succeeded but the compiled app couldn't be saved to your files: NetworkError when attempting
> to fetch resource."

and told the operator to tap **RECOMPILE** — to spend credits rebuilding an app that already existed,
was already published, and was still downloadable.

The plumbing: `CompilePanel` awaited `onCompileSuccess` → `useWorkspace.saveCompiledArtifacts` → the
server function `saveCompiledArtifacts`, all as **ONE long HTTP request** that downloaded every release
asset from GitHub and re-uploaded each into Morpheus storage **sequentially in a loop** — ~217 MB across
the two disk images. The browser's own timeout is 210 s (`src/api/base44Client.js`
`API_FETCH_TIMEOUT_MS`), but **Cloudflare's proxy read timeout is ~100 s**, so the edge cut the
connection first and the client's own timeout message never appeared. `useWorkspace` caught the
`NetworkError` and returned `{ error: e.message }`, and the panel treated that as the build's verdict.
Both halves are the defect: a long job on the request path, and one catch that erases the difference
between "the app was not built" and "the app was built but not copied".

**Rule: a build's verdict is decided by the build, and nothing downstream of it may overwrite that.**
When a long job follows a success, it runs off the request path (a background job the client polls),
it persists progress as it goes so a reload can reconstruct it, and a failure in it is reported as its
own state — naming the working fallback — never as a failure of the step that already succeeded. This is
H14's "a green build can ship an artifact that cannot run" seen from the other side: **a green build must
not be reported as a red one either.** Two concrete guards: never put a >100 s job behind one HTTP
request when a proxy sits in front of it, and never let one `catch` collapse "save failed" into the
phase that offers a rebuild. `scripts/verify-artifact-save-background.mjs` asserts the save is a polled
background job that stays streamed and resumable, and that a failed or interrupted save renders as
`BUILD SUCCEEDED — THE APP COULDN'T BE SAVED TO YOUR FILES` with the release links and no RECOMPILE.

