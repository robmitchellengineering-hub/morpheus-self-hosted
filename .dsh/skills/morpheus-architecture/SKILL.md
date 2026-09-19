---
name: morpheus-architecture
description: "Orientation map of morpheus-self-hosted: how an HTTP request reaches a function handler, how the AI build loop and self-dev delivery engine work, what the Prisma model and React SPA own, and the invariants that are easy to break."
whenToUse: "Load when starting work in morpheus-self-hosted and you need to know how a request or a build actually flows, which subsystem owns a file, or which invariant a change might break."
---

# Morpheus architecture

A chat-driven AI app builder that develops itself. Two apps live in one repo:

- `server/` — Node + Express + Prisma/Postgres. Owns auth, the function registry, the AI
  pipeline, self-dev, billing and delivery.
- `src/` — Vite 6 + React 18 SPA (Matrix theme) plus the separately-installed Command Deck PWA.
  It is a thin client over `server/`; only `src/api/base44Client.js` and `src/lib/AuthContext.jsx`
  were rewritten from the original Base44 app.

`main` is production for both halves (Netlify + Northflank). Start with `AGENTS.md` for the
operating rules and `.dsh/skills/morpheus-dev-protocol/` before changing anything.

## How a request flows

A frontend call is almost always `base44.functions.invoke(name, body)` → `POST /api/functions/<name>`
with a Bearer token. On the server:

1. `server/src/index.js` mounts the routers; `/api/functions` goes to
   `server/src/routes/functions.routes.js`.
2. `router.all('/:name')` validates the name against `/^[A-Za-z][A-Za-z0-9]*$/`, requires
   `server/src/functions/<name>.js` to exist, and 400s/404s before auth if either fails.
3. Unless the name is in `PUBLIC_FUNCTIONS` (7 names), the request passes `requireAuth`, which
   accepts a JWT, a `wgt_` widget token, or a `dvc_` device token.
4. Scoped tokens are narrowed: rejected for any `ADMIN_FUNCTIONS` name and for anything outside
   their scope map; widget calls get `projectId` force-injected.
5. Names in `ADMIN_FUNCTIONS` (12) additionally pass `requireAdmin`.
6. `runFunction()` dynamically imports the file and calls
   `handler({ user, body, query, req, res })`. Return a value → JSON; write to `res` yourself →
   the dispatcher returns early on `res.headersSent` (this is how streaming works).

The only non-function routes are `/api/entities/*` (generic CRUD), `/api/uploads`,
`/api/media-assets`, `/api/connections`, `/api/auth`, and `/api/admin/*` (one router-level
`requireAuth + blockWidget + requireAdmin` for the whole prefix).

Deep dive: `references/server-routing.md`.

## How a build flows

`chatWithMorpheus` streams NDJSON and runs, in order: pre-flight and context selection → optional
web research → optional repo research → planner (with self-dev diagnostic tool rounds) → a
clarification gate → external-API pre-flight → a chunked coder → diff-edit resolution → reviewer
with up to 3 retries → deterministic syntax / self-dev deep-verify / a11y gates → snapshot and
file application → optional UI polish → GitHub sync. Every model call goes through
`invokeAI()` in `server/src/ai.js`, which owns provider tiers, credit reservation and
reconciliation, vision fallback, and truncation semantics.

Deep dive: `references/ai-pipeline.md`.

## How a self-dev change reaches production

A singleton admin-only `Project` with `project_type: 'self_dev'` mirrors
`robmitchellengineering-hub/morpheus-self-hosted@main` as `ProjectFile` rows. The loop is sync
(`importSelfDevRepo`) → esbuild verify (`verifySelfDev`) → ship (`pushSelfDevToGithub`, one
diff-only commit onto `self-dev/<ts>` + PR by default) → squash-merge on green
(`mergeSelfDevPr`) → post-deploy smoke check (`smokeCheckSelfDev`) → one-click revert
(`revertSelfDevPush`). The mechanism lives in the shared engine (`server/src/lib/engine/`) reached
through delivery adapters (`server/src/lib/delivery/`); the self-dev functions keep only the
admin gate and the side effects.

Deep dive: `references/self-dev.md`.

## Subsystem map

| Subsystem | Owns | Start at |
| --- | --- | --- |
| HTTP / routing | middleware order, route mounts, the function registry, auth + scoped tokens | `server/src/index.js`, `server/src/routes/`, `server/src/auth.js` |
| Data model | 52 Prisma models, generic entity CRUD, owner scoping, the hand-run migration workflow | `server/prisma/schema.prisma`, `server/src/entities.js` |
| AI pipeline | `invokeAI`, the chat build loop, reviewer, edit application, billing/metering | `server/src/ai.js`, `server/src/functions/chatWithMorpheus.js` |
| Self-dev + delivery | the mirror, verify/ship/merge/rollback, engine policy, safety gates | `server/src/lib/engine/`, `server/src/lib/delivery/` |
| Frontend | routes and guards, auth context, the API client, the Command Deck PWA | `src/App.jsx`, `src/api/base44Client.js`, `deck.html` |
| Infra + deploy | containers, build/prebuild, CI, Netlify + Northflank, env inventory | `Dockerfile`, `.github/workflows/ci.yml`, `package.json` |

## Load-bearing invariants

These are the ones a plausible-looking change breaks.

1. **Business functions are deny-by-default.** A new handler file is authenticated unless its name
   is added to `PUBLIC_FUNCTIONS`; it is admin-gated only if its name is added to
   `ADMIN_FUNCTIONS`. Neither is a convention or a decorator.
2. **Scoped tokens can never reach an admin gate.** `wgt_`/`dvc_` tokens are 403'd for
   `ADMIN_FUNCTIONS` before `requireAdmin` runs, and every non-function authed router mounts
   `blockWidget` so a scoped token cannot inherit the full account.
3. **`entities.js scope()` is the RLS replacement, and its admin bypass is the default.** An admin
   sees every account's rows for every entity in `ENTITY_MAP` **except** names starting with
   `Deck`. Any new per-user model added to `ENTITY_MAP` inherits cross-account exposure for admins.
4. **Deck is private per account** and must never reuse a Morpheus-level entity. `DeckGoogleConnection`
   is not `GoogleDriveConnection`; `DeckJarvisMessage` is not `ChatMessage`.
5. **A `schema.prisma` change ships its `server/prisma/selfdev-<slug>.sql` in the same change.**
   There is no migrations directory; the backend deploy runs `prisma generate` only. `add-*.sql`
   files are hand-run and tracked by nothing.
6. **A self-dev push diffs the local mirror against the live remote tree, so a stale workspace
   deletes whatever landed upstream** (incident H9). `lib/selfDevDrift.js` refuses a push whose
   recorded sync point disagrees with `main`'s HEAD, or that deletes more than 10 files unscoped.
7. **`force` is one flag for four protections**: it skips esbuild verify, chooses direct-to-main,
   bypasses the drift guard, and bypasses the schema-migration gate.
8. **`invokeAI` throws `OUTPUT_TRUNCATED` only for schema calls.** Prose calls return truncated text
   instead. Omitting `maxTokens` does not remove the ceiling — it hands control to the provider
   default (hazard H6).
9. **The frontend API base is runtime, not build-time** (`?api_base=` → localStorage
   `morpheus_api_base` → `VITE_API_BASE_URL` → `/api`) and is resolved once at module load.
10. **`main` is production and the pre-push hook refuses a direct push to it.** Every change lands
    through a PR, including self-dev's (unless an admin forces).

## Easy-to-get-wrong traps

- `npm run build` runs `prebuild`, which **overwrites** `src/MORPHEUS_DESIGN_PLAN.md`. `git checkout`
  it if you did not mean to change it (H3).
- `router.all('/:name')` means GET and DELETE reach the same mutating, credit-spending handler.
  Only the name allowlist and the auth gate distinguish endpoints.
- There is no request-validation library anywhere in `server/src`. Validation is manual per handler.
- There is no shared 404 handler for unmatched `/api/*`, so those return Express's default HTML,
  not the `{error}` JSON the client expects.
- `ProtectedRoute adminOnly` is a **UI** guard only; the server re-checks.
- The reviewer's verdict does not block a commit — only the deterministic gates produce criticals.
- `server/prisma/manual-supabase-init.sql` covers only 25 of 52 models, and
  `add-project-documents-table.sql` creates a table no model references.
- `docker compose` runs `prisma migrate deploy` with no migrations directory, so it is a no-op.
- The self-dev mirror excludes `base44/`, but a frontend file imports from it — verify marks that
  import external to avoid a false failure.

## Reference files

- `references/server-routing.md` — Express boot and middleware order, every route mount, the
  filename-dispatched registry, `PUBLIC_FUNCTIONS` / `ADMIN_FUNCTIONS`, widget and device token
  scoping, error and validation conventions.
- `references/data-model.md` — the 52 models grouped by concern, cascades and the soft-FK
  exceptions, `entities.js` and `scope()`, and the `selfdev-*.sql` vs `add-*.sql` migration split
  with the known drift.
- `references/ai-pipeline.md` — `invokeAI` internals (provider tiers, credits, vision fallback,
  truncation) and the chat build loop phase by phase with the constants that bound each stage.
- `references/self-dev.md` — the lifecycle, `engine/{ship,merge,verify}.js`, the delivery adapters,
  direct vs PR mode, scoped vs unscoped pushes, every safety gate and the H9 drift guard.
- `references/frontend.md` — app structure, routing and guards, auth context, the API client, data
  fetching conventions, the Command Deck PWA and build config.
- `references/infra-deploy.md` — containers and serve setup, build scripts and `prebuild`, CI, the
  commit-to-production path, satellite directories, and the full env-var inventory.

## Provenance and confidence

`server-routing.md`, `data-model.md` and `ai-pipeline.md` are built from the completed
8-area audit of this repo. The audit artifact was truncated before the self-dev, frontend and
infra areas, so `self-dev.md`, `frontend.md` and `infra-deploy.md` were written from direct
source review at commit `509d2ce` instead. Each file states its provenance at the top and marks
anything unverified under "Open questions" rather than asserting it.
