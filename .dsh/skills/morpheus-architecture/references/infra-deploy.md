# Infrastructure, build pipeline, deploy path and external services

Provenance note: the audit artifact for this area was lost to a harness truncation, so this file
was written from **direct source review** of `morpheus-self-hosted` at commit `509d2ce`
(2026-09-19), not from the audit. Line numbers are from that commit.

## Containers and serve setup

**Root `Dockerfile` (frontend).** Multi-stage: build stage `node:20-alpine` → `npm install
--no-audit --no-fund` → `COPY . .` → **`rm -rf server base44 public/portable-morpheus/_source`
(Dockerfile:10) → `npm run build` (:11)**; runtime stage `nginx:1.27-alpine` copying `/app/dist` to
`/usr/share/nginx/html` and `nginx.conf` to `/etc/nginx/conf.d/default.conf`, `EXPOSE 80` (:13-16),
with no `CMD` override and no `HEALTHCHECK`. Note the ordering: `base44/` is deleted *before* the
Vite build, while `src/components/matrix/BackendPanel.jsx:13` imports
`../../../base44/shared/infrastructureComponents` at bundle time — whether this image still builds
is unverified.

**`server/Dockerfile` (backend, one image for API and worker).** Single stage `node:20-alpine`
(:5-6): `apk add --no-cache openssl chromium nss freetype harfbuzz ca-certificates font-freefont
python3` (:32) and `ENV CHROMIUM_PATH=/usr/bin/chromium-browser` (:33) — the comments record the
Alpine/Prisma libssl crash (:8-14), `puppeteer-core` + Alpine `chromium` for `selfDevTools.js`'s
`screenshot_preview` (:16-23), and CPython for `syntaxCheck.js` (:25-31). Then `npm install
--omit=dev` (:36), `COPY prisma ./prisma` + `npx prisma generate` (:38-39), `COPY src ./src` (:41),
`ENV NODE_ENV=production` (:44), `EXPOSE 4500` (:45), `CMD ["node","src/index.js"]` (:47). No
`HEALTHCHECK`.

**`docker-compose.yml`** (project name `morpheus`):

| Service | Image / build | Ports | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16-alpine` | `5432:5432` | user/password/db all `morpheus`; volume `postgres_data`; healthcheck `pg_isready` |
| `redis` | `redis:7-alpine` | `6379:6379` | healthcheck `redis-cli ping` |
| `backend` | `./server` | `4500:4500` | `env_file ./server/.env`; overrides `DATABASE_URL` and `REDIS_URL`; depends on healthy postgres+redis; volume `backend_storage:/app/data/storage`; `command: npx prisma migrate deploy && node src/index.js`; `restart: unless-stopped` |
| `worker` | `./server` | — | `command: node src/worker.js`; `profiles: ["worker"]`, so it only starts with `--profile worker`; a no-op until a queue producer exists |
| `frontend` | `.` | `8080:80` | no runtime env — nginx reaches `backend` by Docker DNS |

Volumes: `postgres_data`, `backend_storage`.

**`nginx.conf`.** `listen 80`, `root /usr/share/nginx/html`, gzip on (:7-15); `location /api/` →
`proxy_pass http://backend:4500` with `proxy_read_timeout 300s` (:17-26); `location /uploads/` → the
same upstream (:29-30); SPA fallback `try_files $uri $uri/ /index.html` (:35-36); `/assets/` cached
`1y` immutable (:41-43). **There is no `/deck` rule**, so an nginx-served `/deck` resolves to
`index.html` (see `frontend.md`).

**Listener and storage facts.** API port `process.env.PORT || 4500` (`index.js:63-65`). The only
health path is `GET /api/health` → `{ok, service:'morpheus-server', time}` (:44) —
`checkDeployHealth` pings a *user project's* URL, not this server. `storage.js` sets
`LOCAL_ROOT = path.join(__dirname, '..', 'data', 'storage')` (:17), i.e. `/app/data/storage` in the
image, exactly the compose bind mount; `STORAGE_DRIVER` defaults to `local` (:19), and the `s3`
branch uses the `S3_*` vars with `forcePathStyle: !!S3_ENDPOINT`. Local URLs are
`${BACKEND_PUBLIC_URL}/uploads/<key>` or relative `/uploads/<key>` when that is unset (:66-67,
:108-109).

## Build scripts

### Root `package.json`

| Script | Command | Notes |
| --- | --- | --- |
| `dev` | `vite` | port 5173; proxies `/api` and `/uploads` to `VITE_BACKEND_URL` or `http://localhost:4500` |
| `sync:capabilities` | `node scripts/sync-capabilities.mjs` | also run by prebuild |
| `prebuild` | `node scripts/sync-capabilities.mjs && node scripts/pack-wp-plugin.mjs` | runs automatically before `build` |
| `build` | `vite build` | Vite default outDir `dist/`, publicDir `public/` |
| `lint` | `eslint . --quiet` | |
| `lint:fix` | `eslint . --fix` | |
| `typecheck` | `tsc -p ./jsconfig.json` | |
| `preview` | `vite preview` | |

There is **no `postbuild`** script. `"type": "module"`; the package name is still `base44-app`.

**What `prebuild` does exactly:**

1. `scripts/sync-capabilities.mjs` reads `src/lib/morpheusCapabilities.json` and **overwrites**
   `src/MORPHEUS_DESIGN_PLAN.md` (:13-14, :42). This is hazard H3 and the reason CI warns when that
   file changes.
2. `scripts/pack-wp-plugin.mjs` copies `wp-plugin/morpheus` into a staging cache, deletes the
   `tests` dir, zips it with the `zip` CLI to `public/morpheus-wordpress-plugin.zip`, and writes
   `public/plugin-manifest.json` with the `Version:` header parsed from
   `wp-plugin/morpheus/morpheus.php` (:17-19, :27-42). Missing source is a warning and exit 0;
   a failure is exit 1 (:22-25, :43-46).

### `server/package.json`

`dev: node --watch src/index.js`, `start: node src/index.js`, `worker: node src/worker.js`,
`prisma:generate`, `prisma:migrate` (`prisma migrate deploy`), `prisma:migrate:dev`,
`prisma:studio`. **No build, lint, or prebuild.** `engines.node: ">=20"`.

There is no `server/prisma/migrations/` directory, so the compose `prisma migrate deploy` and the
`prisma:migrate` script have no migration set to apply — the schema reaches Postgres through
hand-run `server/prisma/*.sql` (see `data-model.md`).

### `scripts/` inventory

| Script | Purpose | Routed? |
| --- | --- | --- |
| `sync-capabilities.mjs` | prebuild: regenerates `src/MORPHEUS_DESIGN_PLAN.md` | npm `prebuild` |
| `pack-wp-plugin.mjs` | prebuild: zips the WP plugin into `public/` + version manifest | npm `prebuild` |
| `verify-drift.mjs` | runtime test of `server/src/lib/selfDevDrift.js` (`evaluateDrift`, `MAX_UNSCOPED_DELETIONS`, an H9 replay) | CI only (`ci.yml:76`) |
| `sync-portable-morpheus.mjs` | copies base44 shared/entities/functions and several `src/` dirs into `public/portable-morpheus/_source/` | **unrouted** — no npm script or CI reference |
| `dsh-new-task.sh` | fetches origin, refuses a dirty tree, creates `dsh/<slug>` from `origin/main` | manual |
| `pw` | wraps `playwright-cli` with `HOME=$REPO/.playwright/home` | manual |
| `usage` | reads the DSH session projection cache; `--all`, `--json`; estimates deepseek-flash cost | manual |

### `dist/` layout

Vite emits `dist/index.html`, hashed JS/CSS under `dist/assets/`, `dist/manifest.json`,
`dist/deck.html`, `dist/deck-manifest.json`, both icons, `dist/plugin.js`, plus everything copied
from `public/`: `_redirects`, `plugin-manifest.json` (e.g. `{"version":"0.4.5"}`),
`morpheus-wordpress-plugin.zip`, `docs/backend-functions-reference.md`, and
`portable-morpheus/` (`_source/`, `client/`, `server/`, `package.json`, `README.md`). Multi-entry
build: `main` = `index.html`, `deck` = `deck.html` (`vite.config.js:46-53`).
`__APP_BUILD_TIME__` is injected at build time (:37-39).

## CI

Only one workflow: `.github/workflows/ci.yml` (`name: CI`).

- Triggers: `pull_request` (all PRs) and `push` to `main` (:19-22). Concurrency group
  `ci-<ref>` with `cancel-in-progress: true`; `permissions: contents: read` (:25-30).
- Job `build` ("lint + build", ubuntu-latest): `actions/checkout@v4`; `actions/setup-node@v4`
  with node 22 and npm cache; `npm ci`; `npm run lint`; `npm run build`; then a **non-blocking**
  warning if `git diff --quiet -- src/MORPHEUS_DESIGN_PLAN.md` fails (H3 build noise) (:33-60).
- Job `guards` ("guards (no install)", ubuntu-latest): checkout; setup-node 22 with **no cache and
  no install**; `node scripts/verify-drift.mjs`; then a `find server/src -name '*.js'` loop running
  `node --check` on every file, failing the job on any syntax error (:62-93).

What actually blocks a merge: both jobs are check-runs. GitHub branch protection is **not**
configured in-repo (`DSH-HARNESS.md:114-131` recommends it but notes self-dev's API push to main
would be blocked — status unknown). The in-product auto-merge path does honour them:
`engine/merge.js` polls combined check state through `github.js getPullRequestChecks`, which merges
check-runs and commit statuses, treats `success|neutral|skipped` as OK, any completed non-OK
conclusion as `failed`, and only merges when state is `passing` and the PR is mergeable. So both CI
jobs block the automated self-dev merge; a human `gh pr merge` is gated only by branch protection.

`.githooks/pre-push` refuses any push whose remote ref is `refs/heads/main` or `refs/heads/master`
(exit 1). It is enabled with `git config core.hooksPath .githooks` and is bypassable with
`--no-verify` (which the dev protocol forbids). `.npmrc` sets `min-release-age=7` as a
supply-chain cooldown.

## Commit → production

### Netlify (frontend)

There is **no `netlify.toml`** anywhere outside `node_modules`/`.git`; only `dist/_redirects` and
`public/_redirects` carry Netlify-specific config. The in-repo evidence:

- `ci.yml:5-13` states the only pre-existing PR check was "a Netlify deploy preview — which builds
  the frontend and nothing else".
- `AGENTS.md:21` states the frontend is "Deployed on Netlify (auto-publishes `main`)".
- The SPA + deck rewrites live in `public/_redirects`, copied to `dist/_redirects` by Vite, with
  comments naming Netlify (`public/_redirects:9-12, :19-22`).
- Netlify site slug `morpheus-self-hosted-app`; the deploy-preview URL builder is
  `https://deploy-preview-<prNumber>--morpheus-self-hosted-app.netlify.app`
  (`src/lib/deployPreviewUrl.js:1-3`).
- Production frontend origin defaults to `https://morpheus.nz`
  (`server/src/routes/auth.routes.js:23`, `connections.routes.js:28`).

Netlify's UI build command / publish dir / node version / env vars are not in-repo — unknown.
`base44/config.jsonc` has `installCommand`/`buildCommand`/`outputDirectory` but it is a Base44
platform artifact in the reference-only `base44/` tree, not a Netlify config.

### Northflank (backend)

There is **no Northflank manifest** in the repo. What is in-repo:

- `server/src/lib/northflank.js`: API `https://api.northflank.com/v1` (:24), defaults
  `NORTHFLANK_PROJECT_ID=morpheus-self-hosted` and `NORTHFLANK_SERVICE_ID=morpheus-backend`
  (:45-50).
- A comment states Northflank's CD "already auto-deploys automatically on every push to main
  (that's what SelfDev's PUSH TO PRODUCTION relies on)" (:11-17); the delivery adapter reports
  `deployKind: 'northflank-auto'` (`lib/delivery/selfDev.js:42`).
- The container is Alpine, matching `server/Dockerfile` `node:20-alpine`.
- The backend deploy only runs `prisma generate`, never a migration — the DB is migrated by
  hand-run SQL (`KNOWN-HAZARDS.md:74-82`).
- Northflank integration is read-only unless `NORTHFLANK_WRITE_ENABLED === 'true'`;
  `restartService()` is the only write (:36-38, :110-126).

The Northflank service spec is unknown.

### Deploy watcher and auto-diagnose

`src/pages/SelfDev.jsx` implements the watcher:

- Starts 15 s after a push that has a commit SHA, then polls `base44.admin.getNorthflankStatus()`
  every 20 s, giving up after 45 attempts (`timeout`); `configured === false` yields
  `notConfigured` (:186-227).
- Failure detection is a regex over `service.status.build.status` and
  `…deployment.status` — `/FAIL|ERROR|CANCEL/i` for build, `/FAIL|ERROR|CRASH|BACKOFF/i` for
  deploy — which flips to `failed` and calls `autoDiagnoseDeploy` **once per SHA** (:199-207).
- `autoDiagnoseDeploy` pulls `getNorthflankLogs({search:'error', minutes:30, limit:80, type:'build'})`
  and the runtime equivalent in parallel, then auto-sends a chat turn containing both log blocks,
  demanding a root cause and a `KNOWN-HAZARDS.md` rule, and offering REVERT (:356-370).
- A green deploy runs `runSmokeCheck()` (with a +120 s fallback timer regardless of Northflank);
  a failed smoke check sends the same style of fix turn (:209-217, :236-242, :375-390).
- Server side: `smokeCheckSelfDev.js` (admin-only) calls the `self-dev` adapter's `healthCheck`,
  which probes `${BACKEND_PUBLIC_URL|https://api.morpheus.nz}/api/health` expecting
  `morpheus-server`, `POST /api/auth/me` expecting 401,
  `POST /api/functions/browseTemplates` expecting 200, and the frontend origin expecting
  `id="root"` (`lib/delivery/selfDev.js:115-133`).

`diagnoseIssue.js` is the separate general product diagnosis agent (`type: deploy|compile|github|build`)
and `checkDeployHealth.js` pings a user project's deployed URL — neither is the self-dev watcher.

### How a commit on `main` reaches production

Two sanctioned routes, both blocked from a direct `git push main` by the pre-push hook:

1. **Human/agent PR**: branch `dsh/<slug>` (from `scripts/dsh-new-task.sh`) → `npm run lint` +
   `npm run build` → commit → push → `gh pr create --fill` → `gh pr checks` →
   `gh pr merge --squash` (`.dsh/skills/morpheus-dev-protocol/SKILL.md:29-67`).
2. **In-product self-dev**: SYNC → verify (`lib/engine/verify.js`) → `pushSelfDevToGithub.js`
   builds one diff-only commit onto `self-dev/<ts>` + PR by default, or straight to `main` with
   `force`/`directToMain:true` → `mergeSelfDevPr.js` polls checks and squash-merges
   (`lib/engine/merge.js`). See `self-dev.md`.

`main` then triggers Netlify auto-publish (frontend) and Northflank auto-deploy (backend).
The target is pinned in `server/src/lib/selfDevRepo.js:15-18`:
`robmitchellengineering-hub/morpheus-self-hosted`, branch `main`.

## Satellite directories

| Directory | What it is | Live at runtime? |
| --- | --- | --- |
| `base44/` | 35 function dirs, 11 `.jsonc` entity schemas, `shared/`, `connectors/`, `config.jsonc` | **Partially.** Documented reference-only (README, AGENTS.md), excluded by `shouldExclude` (`selfDevRepo.js:39-48`), and self-dev marks `base44/` imports external in verify. But `src/components/matrix/BackendPanel.jsx:13` imports `base44/shared/infrastructureComponents` at bundle time, and `scripts/sync-portable-morpheus.mjs` copies parts of it into the portable download. The 35 functions and entity schemas are vestigial. |
| `hosted-broker/` | Optional separate service (own Dockerfile on port 4600, `src/{server,rateLimit,exchangeStore,deviceStore}.js`) | **Not live unless separately deployed.** Reached only by URL through `MORPHEUS_BROKER_URL`; the default placeholder `https://broker.morpheus.invalid` is treated as unconfigured (`server/src/config/hostedDefaults.js:24-30`). |
| `portable-architect/` | Standalone express+jszip library with its own `server/` and `client/` | **Dead** — no import outside its own README anywhere in `src/`, `server/src`, `package.json` or `vite.config.js`. |
| `wp-plugin/morpheus/` | WordPress plugin PHP source (REST, settings, store, GitHub deploy) | **Live as a shipped artifact** — prebuild zips it into `public/` and `public/plugin-manifest.json` lets SetupTab detect version drift. The PHP is not executed by this app. A server-side `delivery/wordpress.js` adapter exists (registered, not auto-selected); its completeness is unknown. |
| `dist-plugin/morpheus-deploy.zip` | An older plugin build under the slug `morpheus-deploy/`, dated 2026-09-10; `dist-plugin/` is gitignored | **Dead** — no script references it. |
| `.claude/` | `launch.json` + `settings.local.json` (Claude Code permissions) | **Dead** — DSH replaced Claude Code. |
| `.playwright/` | `cli.config.json` (userDataDir, chrome channel, no-sandbox args, outputDir); `home/`, `profile/`, `out/` gitignored | **Live harness tooling, not runtime** — used only by `scripts/pw`. |
| `.dsh/` | `skills/<name>/SKILL.md`, auto-discovered at `<projectRoot>/.dsh/skills/` | **Live agent-harness config.** |
| `scripts/` | see the inventory above | Mixed; `sync-portable-morpheus.mjs` is the only unrouted tool. |

## External services and environment variables

| Service | Vars (representative read site) | Notes |
| --- | --- | --- |
| Postgres | `DATABASE_URL` (Prisma datasource; `deployBackend.js` fallbacks) | Required for any DB access. Production is documented as Supabase, reached only through `DATABASE_URL`, not a Supabase SDK. `SUPABASE_PROJECT_REF`/`SUPABASE_ACCESS_TOKEN` are read by `deployBackend.js` and `getBackendLogs.js` for deploy tooling. |
| Core/auth | `JWT_SECRET` (`auth.js:10`), `JWT_EXPIRES_IN` (:11, default `30d`), `ENCRYPTION_KEY` (`lib/crypto.js:7`, AES-256-GCM for secrets at rest), `NODE_ENV`, `PORT` (`index.js:63`, default 4500), `CORS_ORIGIN` (`index.js:27`, **defaults to `*`**), `BACKEND_PUBLIC_URL`, `FRONTEND_URL` (`auth.routes.js:23`, default `https://morpheus.nz`) | `JWT_SECRET` required for auth; `ENCRYPTION_KEY` required to store/re-read user API keys, GitHub tokens and backend API keys. |
| Redis | `REDIS_URL` (`queue.js:21`) | Optional for one instance: without it `getQueue`/`startWorker` return null, `worker.js` exits 0, and the freshness + balance schedules run in-process per replica instead of as BullMQ repeatable jobs. |
| LLM | `LLM_BASE_URL` (default `https://api.deepseek.com`), `LLM_API_KEY`, `LLM_MODEL` (default `deepseek-flash`) — `ai.js:348-386`; `LLM_PLANNER_MODEL`/`LLM_CODER_MODEL`/`LLM_REVIEWER_MODEL`/`LLM_DIAGNOSIS_MODEL` (:323-326); `FALLBACK_LLM_BASE_URL`/`_API_KEY`/`_MODEL` (:202-209, `webResearch.js:53-54`); `MORPHEUS_BROKER_URL`, `MORPHEUS_AI_GATEWAY_URL`, `MORPHEUS_AI_GATEWAY_TOKEN` (`config/hostedDefaults.js:27,40,49`) | Tiers (`ai.js:335-388`): per-user Settings key → deployment `LLM_API_KEY` → AI gateway. With none, `invokeAI` throws (`tier: 'unconfigured'`). `FALLBACK_LLM_*` is the emergency provider when the DeepSeek balance is depleted, for vision assist, and for grounded web research. |
| Balance/freshness monitors | `DEEPSEEK_BALANCE_CHECK_ENABLED`/`_INTERVAL_MS` (default 900000)/`DEEPSEEK_ALERT_EMAIL`; `FRESHNESS_CHECK_ENABLED`/`_INTERVAL_MS` (default 86400000)/`FRESHNESS_NOTIFY_EMAIL` | Optional. Without SMTP the checks still run and are readable at `GET /api/admin/freshness`. |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (`lib/github.js:77,83-84`), `GITHUB_REDIRECT_URI` (default `http://localhost:4500/api/connections/github/callback`) | There is **no `GITHUB_TOKEN`/PAT env fallback** — `getGithubToken` uses a per-project `Project.github_token` or the user's OAuth connection, else throws `GitHub not connected`. |
| Google | `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (`auth.routes.js:177,215`, `lib/deckGoogle.js:42,49`, `lib/googleDrive.js:38,45`), `GOOGLE_REDIRECT_URI`, `GOOGLE_DRIVE_REDIRECT_URI`, `GOOGLE_DECK_REDIRECT_URI` | Optional; without them Google login, Drive connect and Deck Gmail/Calendar/Drive/Docs break. Login can fall back to the broker; Drive and Deck have **no** broker fallback. |
| Stripe | `STRIPE_SECRET_KEY` (`lib/stripe.js:13` throws `not configured`), `STRIPE_WEBHOOK_SECRET` (`stripeWebhook.js:13,48`), `MARKETPLACE_PLATFORM_CUT_PCT` (default 20) | Without the secret key every marketplace checkout/payout/publish throws; no broker fallback by design. |
| Email | `SMTP_HOST`, `SMTP_PORT` (default 587, secure at 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (`lib/mailer.js:8-26`) | Optional: without `SMTP_HOST` the mailer logs instead of sending, so no OTP, export, compile-complete, freshness or balance email. |
| Object storage | `STORAGE_DRIVER` (`local`/`s3`, default `local`), `S3_ENDPOINT`, `S3_REGION` (default `auto`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` (`storage.js:19-97`) | Optional on one instance (local disk); required for more than one backend replica. `STORAGE_DRIVER=s3` with no `S3_*` makes uploads fail. |
| Northflank | `NORTHFLANK_API_TOKEN` (`lib/northflank.js:27,53,117`), `NORTHFLANK_WRITE_ENABLED` (must be exactly `'true'` for `restartService`), `NORTHFLANK_PROJECT_ID` (default `morpheus-self-hosted`), `NORTHFLANK_SERVICE_ID` (default `morpheus-backend`) | Without the token the Ops Console and SelfDev status/logs degrade to "not configured". |
| Compile/deploy helpers | `PROJECT_REPO_PREFIX` (default `morpheus-project-`), `COMPILE_BUILD_REPO_PREFIX` (default `morpheus-build-`), `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, `VERCEL_TOKEN`, `NETLIFY_TOKEN`, `RENDER_API_KEY`, `BASE44_APP_ID` (still read by 4 checkout/publish functions) | Optional operator-level fallbacks for naming repos, deploying user backends to Cloudflare Workers, and fetching logs for user deployments. `BASE44_APP_ID` behaviour when unset is unverified. |
| Build-time gates | `PYTHON_BIN` (default `python3`, `lib/syntaxCheck.js:34`), `CHROMIUM_PATH` (default `/usr/bin/chromium-browser`, `lib/selfDevTools.js:207`) | A missing Python interpreter skips `.py` files rather than failing; Chromium is required for the self-dev screenshot tool. |
| Frontend `VITE_*` | `VITE_API_BASE_URL` (default `/api`), `VITE_GOOGLE_AUTH_ENABLED` (only `"false"` disables Google sign-in), `VITE_BASE44_APP_ID`, `VITE_BASE44_FUNCTIONS_VERSION`, `VITE_BASE44_APP_BASE_URL`; `VITE_BACKEND_URL` (config-time dev proxy only, not exposed to the client) | Root `.env*` is gitignored and absent here, so these are unset unless the deploy supplies them. |

**Not real reads by this server:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
`TURSO_*`, `CLERK_SECRET_KEY`, `R2_ACCOUNT_ID`, `UPSTASH_REDIS_REST_*` appear only inside
`codegenHint` string literals in `server/src/lib/infrastructureComponents.js` (instructions for
generated user projects), and `SHEET_WEBHOOK_URL` only inside a generated form-handler template
(`lib/projectForms.js:84`). **Documented but read nowhere in source:**
`STRIPE_PUBLISHABLE_KEY`, `TTS_ENGINE`, `TTS_API_KEY`.

## Load-bearing invariants

1. `main` is production for both halves: Netlify publishes the frontend, Northflank deploys the
   backend. The pre-push hook enforces that neither is written by a direct `git push`.
2. `prebuild` mutates a tracked source file (`src/MORPHEUS_DESIGN_PLAN.md`) as a side effect of
   `npm run build` — revert it if you did not mean to change it (H3).
3. `npm run build` produces **two** HTML entries; anything that only fixes `index.html` routing
   misses `/deck`.
4. CI runs on PRs and on `main`; the self-dev auto-merge path reads the same checks, so a red
   `lint + build` or `guards` job stops an automated merge.
5. The backend image must keep `chromium` (self-dev screenshots) and `python3` (syntax gate);
   `prisma generate` runs at image build, but no migration runs at deploy.

## Risks

- **The Docker frontend build deletes `base44/` before Vite runs, while a live import of
  `base44/shared/infrastructureComponents` exists** (`Dockerfile:10` vs
  `src/components/matrix/BackendPanel.jsx:13`). The built `dist/assets/BackendPanel-*.js` currently
  contains that code, so the container build path is suspect. Unverified whether
  `docker compose up --build` still succeeds.
- **`nginx.conf` has no `/deck` rule**, so the containerized frontend serves the main app for
  `/deck`; only Netlify and the Vite dev middleware map it to `deck.html`.
- **`prisma migrate deploy` runs in compose but there is no migrations directory**, so it is a
  no-op and the DB is entirely hand-migrated (see `data-model.md` for the resulting drift risks).
- **`scripts/sync-portable-morpheus.mjs` is unrouted** — the portable download it is meant to
  populate can silently go stale.
- **`min-release-age=7` in `.npmrc`** means a fix published recently may not be installable for a
  week; a CI install can differ from a local one when a fresh release is in range.
- **`dist-plugin/morpheus-deploy.zip` and `base44/`'s 35 functions** look deployable but are not
  wired to anything — an agent could edit them expecting an effect.

## Open questions

- Netlify UI build command / publish dir / node version / env vars (no `netlify.toml` in-repo).
- The Northflank service spec (repo/branch, Dockerfile path, env vars, replicas, health check).
- The production `DATABASE_URL` / Postgres host. Supabase is documented in the skill, not
  source-verified.
- Whether `docker compose up --build` currently builds the frontend given the `base44/` deletion.
- GitHub branch-protection state on `main` (recommended in `DSH-HARNESS.md`, not evidenced).
- Completeness of the WordPress delivery adapter's PHP write path.
- `BASE44_APP_ID` behaviour when unset in the four functions that read it.
