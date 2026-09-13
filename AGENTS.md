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

## Stack

| Part | Tech | Notes |
|---|---|---|
| Frontend | Vite 6 + React 18, react-router-dom, Radix UI, Tailwind 3, framer-motion, three.js | `src/`. Matrix theme. Deployed on Netlify (auto-publishes `main`). |
| Backend | Node + Express + Prisma, BullMQ worker, S3-compatible storage, Stripe, nodemailer | `server/`. Deployed on Northflank (Alpine container). |
| Database | PostgreSQL via Prisma | Migrations in `server/prisma/migrations/`. Redis optional (enables the BullMQ worker). |
| AI | OpenAI-compatible `/chat/completions`, `response_format: json_object` | `server/src/ai.js` `invokeAI()`. Primary `LLM_MODEL=DeepSeek-V4.1-Flash`, fallback `gemini-flash-latest`. Per-user BYO key supported. |

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

- **Local dev:** backend `cd server && npm install && node src/index.js` (port 4500);
  frontend `npm install && npm run dev` (Vite, port 5173, proxies `/api`). Or
  `docker compose up --build` for the whole stack. There is no `base44 dev`.
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
See `ROADMAP.md` for what's built and what's next.
