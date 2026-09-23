# Morpheus

Morpheus is a chat-driven, AI-powered app builder: describe what you want,
and an autonomous planner → coder → reviewer loop writes, tests, and
iterates on real project files, then compiles them into a deployable
target (a web app, an Android APK, an iOS app, a Windows/Mac/Linux
executable, a Raspberry Pi image, Arduino firmware, or a plain Python
package) via generated GitHub Actions workflows. Finished projects can be
pushed to GitHub, deployed to a hosting platform of your choice, or
published to an in-app template marketplace.

This repository is a fully self-hosted rewrite: the original Base44
BaaS backend (entity store, auth, AI gateway, per-user connectors) has been
replaced with a plain Node/Express API backed by PostgreSQL (via Prisma)
and Redis, so you can run the whole stack — frontend, backend, database —
on your own infrastructure with no dependency on a third-party platform.
See `SCALING.md` for how this same codebase scales from a laptop to
millions of users, and `server/PORTING_GUIDE.md` for the mapping between
the original platform APIs and this stack, if you're extending it.

## Quickstart (Docker Compose)

The fastest way to run everything — Postgres, Redis, backend, frontend —
is Docker Compose:

```bash
cp server/.env.example server/.env
# then edit server/.env — at minimum, set JWT_SECRET and ENCRYPTION_KEY:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"       # JWT_SECRET
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"    # ENCRYPTION_KEY

docker compose up --build
```

- Frontend: http://localhost:8080
- Backend API: http://localhost:4500
- Postgres/Redis run as internal services; `docker compose up --build --profile worker` also starts the background job worker.

Everything else in `server/.env` — AI provider, GitHub/Google OAuth,
Stripe, S3, SMTP — is optional. Without any of it configured, you can still
register an account, chat, and generate project files once you either add
your own `LLM_API_KEY` or set `MORPHEUS_BROKER_URL` (see **Connector
configuration** below) to use a shared default.

## Running without Docker

```bash
# 1. Database + cache (or point at your own Postgres/Redis instances)
docker run -d -p 5432:5432 -e POSTGRES_USER=morpheus -e POSTGRES_PASSWORD=morpheus -e POSTGRES_DB=morpheus postgres:16-alpine
docker run -d -p 6379:6379 redis:7-alpine

# 2. Backend
cd server
cp .env.example .env   # edit as above
npm install
npx prisma migrate deploy   # or `npx prisma migrate dev` on first run to create the migration
node src/index.js           # listens on PORT (default 4500)

# 3. Frontend, in a second terminal, from the repo root
npm install
npm run dev                 # Vite dev server; proxies /api and /uploads to VITE_BACKEND_URL (default http://localhost:4500)
```

For a production frontend build: `npm run build` produces `dist/`, which
`Dockerfile` (root) serves via nginx — see `nginx.conf` for the `/api` and
`/uploads` reverse-proxy config it relies on if you deploy `dist/` behind
your own web server instead.

### Driving the embeddable dock locally

The dock is `public/plugin.js` → `/embed?token=…` → `src/pages/Embed.jsx`: the
same tab components as the app's WEBSITE panel, scoped by a **widget token**
instead of a user session. None of the steps above produce a token to open it
with, so it has its own rig:

```bash
node scripts/dev-dock-rig.mjs up      # stack + mocks + fixture data + 2 widget tokens
node scripts/dev-dock-rig.mjs url     # prints the /embed?token=… URL to open
node scripts/dev-dock-rig.mjs drive   # scripts/pw: render it, click it, read the console
node scripts/dev-dock-rig.mjs status  # what is running, and what is seeded
node scripts/dev-dock-rig.mjs down    # stop everything the rig started
```

What it does, and what it assumes:

- It **reuses the embedded Postgres cluster** from `npm run dev:db` (starting it
  if it is not up) but works in its **own database** (`morpheus_dock_rig`), so a
  second session on the same machine cannot read, reset or delete this one's
  rows. It refuses to push a schema at any database whose name does not end in
  `_dock_rig`.
- It starts a **mock OpenAI-compatible provider** on :4599 and a **mock
  WordPress plugin** on :4600. The rig forces `LLM_BASE_URL`/`LLM_MODEL` at the
  mock and blanks the broker and fallback tiers, so no real model call can be
  made or paid for whatever `server/.env` says. The mock WordPress HMAC-verifies
  every signed POST against the secret stored on the connection row, so a green
  run cannot come from an unsigned request.
- It creates `server/.env` from `server/.env.example` if you have not already,
  filling in local-dev values for `NODE_ENV`, `JWT_SECRET` and
  `ENCRYPTION_KEY`. It never overwrites a value you have set, and it never
  commits the file.
- It seeds a fixture owner, a `web-app` project (the target the WEBSITE surface
  needs), the WordPress connection, and **two widget tokens** — `full` (every
  scope) and `chat-only` — through the real server code, so only each token's
  SHA-256 is stored, exactly as in production. The plaintext is written only to
  the gitignored `server/data/dock-rig/state.json`; `url` prints it and `drive`
  redacts it out of its own output.
- `drive` needs the browser to be drivable — see the `playwright-cli` skill
  (`scripts/pw`, never `playwright-cli` directly). It writes screenshots to
  `.playwright/out/`.
- Ports are backend 4500, frontend 5173, mocks 4599 and 4600. If something else
  holds one, override with `DOCK_RIG_BACKEND_PORT`, `DOCK_RIG_FRONTEND_PORT`,
  `DOCK_RIG_MOCK_LLM_PORT` or `DOCK_RIG_MOCK_WP_PORT`.

## Hosting the frontend on a free static host, separately from the backend

You don't need the backend running anywhere reachable to put the UI up for
a look, and you don't need to rebuild every time you point it at a
different backend — the API base is a runtime setting, not a build-time
one (see `src/api/base44Client.js`).

1. `npm install && npm run build` locally — produces `dist/`.
2. Drop `dist/` onto [Netlify Drop](https://app.netlify.com/drop) (drag the
   folder into the browser tab — no account or CLI needed) for an instant
   public HTTPS URL. Vercel (`npx vercel dist --prod` or the dashboard) and
   Cloudflare Pages work the same way and are also free.
3. Once your backend is running somewhere reachable (your own server, a
   free-tier host, etc.), open the hosted frontend URL once with
   `?api_base=` pointing at it, e.g.
   `https://your-site.netlify.app/?api_base=https://your-backend.example.com/api` —
   this is saved in the browser (localStorage), so every later visit reuses
   it without the query param.
4. Add the frontend's hosted URL to `CORS_ORIGIN` in the backend's
   `server/.env` (comma-separated if you already have others), and restart
   the backend — otherwise the browser will block the requests.
5. If you're using local disk storage (`STORAGE_DRIVER=local`) on the
   backend, also set `BACKEND_PUBLIC_URL` to the backend's public URL —
   uploaded-file links are otherwise relative and resolve against the
   frontend's origin instead of the backend's, which 404s once the two are
   on different hosts. S3-backed storage doesn't need this.

## Connector configuration

Morpheus talks to a handful of external services — an AI provider, GitHub
(to push generated code and drive compiles), Google (optional login),
Stripe (optional marketplace) — and every one of them resolves the same
way, most-specific first:

1. **Per-account override** — a user's own AI provider/key, set in
   Settings → AI Provider in the app itself. Nothing to configure on your
   end; this always exists as an option.
2. **This deployment's own credentials** — the `GITHUB_CLIENT_ID`,
   `GOOGLE_CLIENT_ID`, `LLM_API_KEY`, `STRIPE_SECRET_KEY`, etc. in
   `server/.env`. This is the normal way to run a real deployment: your own
   GitHub OAuth App, your own AI provider key, full control, no shared
   dependency.
3. **Morpheus Cloud defaults** — if tier 2 is left unset for a given
   connector, the backend falls back to `MORPHEUS_BROKER_URL`, a small
   separate service (see `hosted-broker/`) that holds a shared GitHub OAuth
   App, Google OAuth Client, and AI key so a brand-new self-hosted instance
   works immediately with zero setup, then graduates to its own credentials
   connector-by-connector whenever you're ready. This tier is entirely
   optional — leave `MORPHEUS_BROKER_URL` unset to require your own
   credentials everywhere.

Stripe (the marketplace) intentionally has no tier-3 default — payouts go
to whoever owns the Stripe account, so that one is always your own key.

To stand up your own tier-3 broker (for your own fleet of instances, or to
offer defaults to others), see `hosted-broker/README.md`.

## Environment reference

`server/.env.example` is the authoritative list, grouped and commented —
core server config, database, Redis, auth secrets, the connector tiers
above, object storage (local disk or S3-compatible), email, and the
compile pipeline. Copy it to `server/.env` and fill in what you need; every
feature degrades gracefully when its config is left blank (e.g. no SMTP
configured just logs emails to the console instead of sending them).

## Repository layout

- `src/` — the React/Vite frontend (unchanged from the original app's UI/UX; only `src/api/base44Client.js` and `src/lib/AuthContext.jsx` were rewritten, to talk to this backend instead of Base44).
- `server/` — the self-hosted backend: Express routes, Prisma schema/client, the generic entity CRUD API, the AI gateway, and every ported business-logic function (chat, autonomous build loop, compile targets, GitHub/marketplace integrations).
- `hosted-broker/` — optional, separately-deployed shared OAuth/AI broker (see above).
- `base44/` — the original app's entity/function definitions, kept for reference; not used at runtime by this stack.
- `SCALING.md` — how this architecture scales past a single instance.
- `FRESHNESS.md` — how Morpheus keeps its own AI model config and npm dependencies from going stale (detects and notifies; never auto-edits code — see that doc for why), and how to check it yourself at `GET /api/admin/freshness`.
- `server/PORTING_GUIDE.md` — the Base44-API-to-this-stack mapping, useful if you're porting more of `base44/` or auditing what changed.

## Docs & support

This is a self-hosted, community-run project — there's no hosted dashboard
or third-party support desk. For build/scaling questions, see `SCALING.md`
and the doc comments throughout `server/src/`.
