# AGENTS.md

## Project context

Morpheus is a chat-driven AI app builder. An autonomous **planner → coder →
reviewer** loop edits real project files, snapshots them, and can compile and
push them to GitHub and deploy. This repository is the **fully self-hosted
rewrite**: the original Base44 BaaS backend has been replaced with a plain
Node/Express + Prisma/Postgres stack. There is **no Base44 dependency at
runtime** and no `base44` CLI in this workflow.

Start with `README.md` for local setup and environment variables. Treat this
as user-owned application code: keep changes focused on the request and
preserve existing conventions (the doc-comment style at the top of most
`server/src/` files in particular — match it).

**Read `KNOWN-HAZARDS.md` before changing anything, and again before writing a
guard.** It is self-inflicted breakage that has already happened here (H1–H23), each with
the incident and the rule. It was only *mentioned* in passing below until 2026-09-30, and
a session consequently re-derived **H18 by hand** — the temporal-dead-zone catch in
`ai.js` — as though it were new, four days after H18 documented it. The reviewer is given
this file on every build turn; a session must be too.

## Stack

| Part | Tech | Notes |
|---|---|---|
| Frontend | Vite 6 + React 18, react-router-dom, Radix UI, Tailwind 3, framer-motion, three.js | `src/`. Matrix theme. Deployed on Netlify (auto-publishes `main`). |
| Backend | Node + Express + Prisma, BullMQ worker, S3-compatible storage, Stripe, nodemailer | `server/`. Deployed on Northflank (Alpine container). |
| Database | PostgreSQL via Prisma | There is **no** `server/prisma/migrations/` directory — migrations are hand-run SQL in `server/prisma/*.sql` (see `KNOWN-HAZARDS.md` H8). `manual-supabase-init.sql` is the full schema for a fresh database. Redis optional (enables the BullMQ worker). |
| AI | OpenAI-compatible `/chat/completions`, `response_format: json_object` | `server/src/ai.js` `invokeAI()`. Primary `LLM_MODEL=deepseek-flash`, fallback `gemini-flash-latest`. Per-user BYO key supported. |

## Key files

- `src/` — frontend. Only `src/api/base44Client.js` and `src/lib/AuthContext.jsx`
  were rewritten from the original; the rest of the UI is unchanged.
- `src/api/base44Client.js` — frontend API client. The API base is a **runtime**
  setting (`?api_base=` / localStorage), not build-time.
- `server/src/routes/` — Express routes. `server/src/functions/` — ported
  business-logic functions (chat, build loop, compile targets, GitHub, marketplace).
- `server/src/ai.js` — the AI gateway. `server/src/entities.js` — generic entity CRUD.
- `server/prisma/schema.prisma` — data model.
- `base44/` — original entity/function definitions, **reference only, not used at runtime**.
- `hosted-broker/` — optional separately-deployed shared OAuth/AI broker.
- `server/PORTING_GUIDE.md` — Base44-API → this-stack mapping.
- `FRESHNESS.md` — how model/dependency drift is detected (notify-only, never auto-edits).

## Working notes

- **Local dev:** there is no system Postgres on the dev machine, so start one with
  `cd server && npm install && npm run dev:db` — that initialises a real cluster under
  `server/data/pg/` (from the `embedded-postgres` devDependency), runs it as a daemon on the
  port in `server/.env`'s `DATABASE_URL`, and creates the database. `npm run dev:db:schema`
  then builds all 52 tables from `schema.prisma`; `dev:db:status` / `dev:db:stop` /
  `dev:db:reset` manage it. Then: backend `cd server && npm install && node src/index.js` (port 4500);
  frontend `npm install && npm run dev` (Vite, port 5173, proxies `/api`). Or
  `docker compose up --build` for the whole stack. There is no `base44 dev`.
- **The dock (the embeddable widget) needs its own rig,** because none of the above
  produces a widget token to open `/embed?token=…` with:
  `node scripts/dev-dock-rig.mjs up` starts the same stack **plus** a mock AI provider and
  a mock WordPress, then seeds a fixture owner, a `web-app` project, a site connection and
  two widget tokens through the real server code. `node scripts/dev-dock-rig.mjs url` prints
  the embed URL and `node scripts/dev-dock-rig.mjs drive` drives it through `scripts/pw`.
  It runs in its own database, and it forces the LLM at the mock so no real model call can
  be made. Full description: `README.md` → "Driving the embeddable dock locally".
- **Before finishing code changes, run the relevant checks:** frontend
  `npm run lint` (eslint, rules-of-hooks enabled) and `npm run build`; backend
  has no separate lint — verify with a build/bundle check.
- `npm run build` runs `scripts/sync-capabilities.mjs` as a prebuild step, which
  **rewrites `src/MORPHEUS_DESIGN_PLAN.md`** — `git checkout` that file before
  committing if you only meant to build.
- `npm install` in `server/` rewrites `server/package-lock.json` (it drops the
  unresolvable `@base44/*` entries) — that lockfile is gitignored; don't commit it.
- Never commit secrets. `server/.env.example` is the authoritative env list.

## Self-dev

Morpheus can develop **itself** through its own workspace: a singleton
admin-only `Project` (`project_type: 'self_dev'`) mirrors this repo, and the
normal chat/plan/code/review/preview flow edits it. The loop is:
sync (pull `main`) → plan/code/review → **verify** (esbuild transform + bundle,
`server/src/functions/verifySelfDev.js`) → **push** (one diff-only commit,
`server/src/functions/pushSelfDevToGithub.js`) → **watch** (Northflank poll,
auto-diagnose failed deploys) → **revert** (one-click, `revertSelfDevPush.js`).
`ROADMAP.md` is the last written plan of record (2026-09-09) — read it as
history, not as status. For what is built and what is next right now, run
`node scripts/reality.mjs`.

## UI conventions

Self-dev reads this file in full on every build (`SELF_DEV_ORIENTATION_FILES` in
`server/src/functions/chatWithMorpheus.js`), so the house UI rules belong here.

Morpheus's own UI is Tailwind with an **ink ladder**: the size of the text decides
which ink token it may use. The wrong rung is a red `verify-prose-ink.mjs`.

| text size | token |
| --- | --- |
| ≤11px | `text-ink-max` |
| 12–13px | `text-ink-strong` |
| ≥14px | `text-ink` |

Never an opacity modifier on an ink token (`text-ink/60`), including on a variant
such as `hover:text-ink-strong`. Green (`text-primary`) marks structure — headings,
labels, badges, actions, metrics, inline emphasis; ink carries the prose. The rule
and its floors live in `scripts/lib/ink-ladder.mjs`.

## Merge gate

Three checks are required to merge into `main`, and since 2026-09-24 **GitHub
enforces this, not only `merge.js`**:

`guards (no install)` · `lint + build` · `render`

- The names live in `server/src/lib/engine/requiredChecks.js`
  (`SELF_DEV_REQUIRED_CHECKS`). `scripts/verify-merge-gates.mjs` asserts they still
  match ci.yml's job names *and* that branch protection still requires the same set —
  otherwise the repo would claim three gates while GitHub enforced two or none.
- `node scripts/check-branch-protection.mjs` reads the live setting. It needs `gh`
  auth and is deliberately **not** in `scripts/verify.mjs`, which must keep working
  with no token and no network; it prints `SKIPPED` loudly rather than passing quietly.
- **Do not reach for `gh pr merge --admin` by habit.** A normal merge now fails with
  "the base branch policy prohibits the merge" while a gate is red or still running,
  and that is the point. `--admin` is the emergency path for when CI cannot run at
  all — which happened on 2026-09-24 when the Actions minutes ran out.
- `strict` ("require branches to be up to date") is **ON**. A PR is therefore
  verified against the exact base its squash lands on. When a head falls behind,
  `merge.js` updates the branch (`updatePullRequestBranch`) and reports `pending`
  rather than merging — the update lands a merge commit that re-runs the checks, so
  a head that was green before the update is not green after it.
- There is no `push: main` CI trigger. It re-tested, at full price, the tree the pull
  request had already verified — about 47% of all runs. The one case it did cover is
  a merge made with `--admin`, which bypasses the checks; after one of those, run the
  workflow by hand (`gh workflow run ci.yml --ref main`).

### Adding a guard is THREE files, not one (2026-10-05)

Written down because a session added a guard, watched it pass locally, and had the build
fail on a check it had never heard of. A new guard is not done until all three are true:

1. **The gate** — the filename goes in the `HARD` list in `scripts/verify.mjs`.
2. **The mutation** — an entry in `scripts/guard-mutations.mjs`, because
   `scripts/verify-guard-mutations.mjs` refuses a hard gate with no mutation (H19: a
   guard whose failure cannot be demonstrated is a comment with a `console.log`). That
   ratchet compares the unproven count to `UNPROVEN_BASELINE` with **equality**: proving
   a previously-unproven guard means lowering the number, and adding an unproven one
   means it goes up and fails. Adding a guard *and* its mutation leaves the number where
   it was.
3. **CI** — a step in `.github/workflows/ci.yml`, in the `guards (no install)` job.
   `scripts/verify-context.mjs` fails with `CI runs every hard gate` and names the
   missing file if you forget. That check is easy to trip and easy to miss, because
   nothing in `verify.mjs` mentions CI: the guard passes locally, the gate passes
   locally, and only CI disagrees.

The same applies in reverse: a guard deleted from `verify.mjs` must have its mutation and
its CI step removed too, or `verify-context.mjs` reports an entry that is not a real
script.

## Agent harness (DSH)

This repo is developed through **DSH** (DeepSeek Harness) via the Web GUI. DSH is
the **sole writer** — do not run a Claude Code session against this repo at the
same time. See `KNOWN-HAZARDS.md` H9 for the incident that rule comes from.

More than one DSH session against this repo at once is normal and fine — that is
what the per-session `git worktree`s are for. **The hazard is one session
committing from the *shared* checkout.** On 2026-09-23 a session ran
`git add -A && git commit` there while another session's sweep sat uncommitted in
the same tree, and the two unrelated changes landed in one commit under one
message; the second session only found out because its branch was suddenly a
commit ahead of `main` that it had not written. So: **keep one worktree per
session, and never `git add -A` in the shared checkout** — stage the explicit
paths you changed, which is a habit worth having even when you are alone.

Project skills under `.dsh/skills/` carry the operating rules. The harness
catalog is the source of truth for what exists; the table below is the map, and
`scripts/verify-context.mjs` fails if a skill on disk is not named here.

| Skill | Load it when |
|---|---|
| `morpheus-dev-protocol` | Before **any** change — branch/PR workflow, never-push-`main`, resync rules |
| `morpheus-hazards` | Before writing or reviewing a change — the H1–H23 checklist of self-inflicted breakage |
| `morpheus-stack` | When you need the stack map, commands, or verification steps |
| `morpheus-architecture` | When you need to know how a request reaches a handler, or how the build loop and self-dev engine work |
| `morpheus-deck` | Before touching anything under `/deck` — own-data architecture, additive migrations, Jarvis persona |
| `morpheus-vision` | Before any Jarvis-driven build or inter-agent work — the deferred vision, so it is not implemented opportunistically |
| `morpheus-build-library` | **The index of build knowledge.** When the task touches something you have not done here before, read the one card it points at (verification, WordPress, AI features, onboarding UX, SEO, compile targets, reality, observability, connections, tooling) instead of guessing |
| `playwright-cli` | Before browser work — `scripts/pw` navigation, snapshots, console/network reads |
| `working-with-rob` | Before planning work or reporting results — how Rob works and what he expects verified |

**Hard rules:**

- **Never push to `main`.** `main` deploys straight to production (Netlify +
  Northflank). Every change lands through a PR, which the agent opens and — once
  checks are green — squash-merges (settled 2026-09-19; see
  `morpheus-dev-protocol`). What is never allowed is pushing to `main` directly.
  A `pre-push` hook in `.githooks/` enforces that mechanically; do not bypass it
  with `--no-verify`.
- **Start every task from a fresh `origin/main`:** `scripts/dsh-new-task.sh <slug>`.
- **Verify before claiming done.** `npm run lint` + `npm run build` for code, and
  load user-visible changes in a real browser: `scripts/pw open http://localhost:5173`.
- **For any change a logged-in user can see, run `npm run render:check` BEFORE pushing.**
  It is the only gate that renders the signed-in surface: every protected page sits behind
  `ProtectedRoute`, so the CI `render` job — which has no session — never even fetches those
  chunks. A blank `/deck/settings` shipped through a fully green pipeline on 2026-10-04 for
  exactly that reason (H22). The script brings up the local rig, seeds a real account, mints a
  **local** session, and loads `/deck`, `/deck/settings`, `/deck/tools`, `/deck/jarvis`,
  `/settings` and `/workspace` in a real browser, failing on any uncaught error, the
  error-boundary screen, a bounce to `/login`, or a page that rendered nothing. Pass routes of
  your own to check just those: `npm run render:check -- /deck/settings`.
- **A compile target is proven by running it, never by reading the adapter** (`morpheus-build-library`
  → `compile-targets`). Most targets are smoke-tested on a runner by `scripts/compile-smoke.mjs`. The three
  **audio plugin** routes have their own manual workflows, because none of them can be built here: the macOS
  standalone's shell needs full Xcode and this machine has only the Command Line Tools, the Windows route
  needs MSVC, and the Linux ARM route needs an aarch64 Linux machine (a plugin compiled for the wrong CPU
  loads nowhere and says nothing). **The project is SHARED between those routes**
  (`server/src/lib/audioPluginProject.js` generates it, `…/audioPluginTemplate.js` holds the sources), so
  **after changing any target, the shared module or the template, dispatch ALL THREE:**
  `.github/workflows/audio-plugin-macos-build.yml`,
  `.github/workflows/audio-plugin-windows-build.yml` and
  `.github/workflows/audio-plugin-linux-arm-build.yml`
  (`gh workflow run <file> --ref main`). Each materialises what its own target generates and runs that
  target's own steps, then uploads the packaged plugins. They are `workflow_dispatch`-only on purpose:
  macOS runner minutes bill at 10x and Windows at 2x.
- **A route that builds for one machine says so — in the id, the label, the downloads and the manual.**
  Rob, 2026-10-04: *"It needs to be clear that that's a macOS only audio plugin route, same for the
  Windows one."* A plugin is the case that makes this load-bearing, because `VST3` exists on more than one
  platform, so a label naming only formats reads as "builds for whatever you are on". **A target in
  `server/src/lib/compile-targets/` is not real until it is in the picker** (`src/lib/compileTargets.js`):
  `audio-plugin` shipped in the registry, absent from the picker and therefore unchoosable, while every
  guard stayed green. `verify-onramp.mjs` now compares the two lists.
- **Revert build noise.** `npm run build` rewrites `src/MORPHEUS_DESIGN_PLAN.md`
  (H3) — `git checkout` it if you didn't mean to change it.
- **A NAM capture starts from the trainer's own `input.wav`, and generating one is not possible.**
  `scripts/audio-capture.mjs` was first written to synthesise a licence-free re-amp signal, and **that file
  cannot be trained on.** NAM's trainer MD5s the whole input and looks it up in a table of known inputs
  (`_detect_input_version`), then falls back to hashing its first 17 s and last 9 s; no match and it raises
  *"cannot be recognized as any known version"* — in the GUI the Train button simply never enables. The
  version it identifies also decides the STRUCTURE the trainer relies on, and v3's is a contract, not
  metadata: 9 s validation, 1 s silence, two impulses at 0:10.5 and 0:11.5, chirps, noise, training data,
  then **the same validation signal again** at the end — which is what makes its replicate-ESR check (did the
  amp hold still for the whole take?) possible at all. So `input` fetches NAM's official 190 s / 48 kHz mono
  file and verifies it against the strong hash in the trainer's source (`36cd1af6…`). `check` and `verify`
  then reproduce the trainer's own pre-flight rather than offering a second opinion that disagrees with it:
  the rules and the impulse-calibration port live in `server/src/lib/audio/namCapture.js`, each traced to
  `nam/train/core.py`, and `scripts/verify-audio-capture.mjs` pins every constant as a literal. **If you
  change a constant there, or the rule it implements, you are changing what the tool promises about someone
  else's program** — re-read their source first.

Harness state: skills live in `.dsh/skills/`; git hooks are enabled with
`git config core.hooksPath .githooks`; browser automation is the Playwright CLI
via `scripts/pw` (config in `.playwright/cli.config.json`). Load the
`playwright-cli` skill before browser work — `scripts/pw find` is far cheaper
than dumping a page tree into context.
