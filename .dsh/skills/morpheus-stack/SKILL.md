---
name: morpheus-stack
description: "Stack map, key files, dev commands and mandatory verification steps for the morpheus-self-hosted repo (Vite/React frontend, Node/Express + Prisma/Postgres backend, Netlify + Northflank deploys)."
whenToUse: "Load when starting work in morpheus-self-hosted and you need to know where code lives, which command runs what, or how to verify a change before opening a PR."
---

# Morpheus stack

Read `README.md` for local setup and environment variables, and `AGENTS.md` for
the authoritative, maintained version of this page. This skill is the quick map.

## What this repo is

Morpheus is a chat-driven AI app builder: an autonomous **planner → coder →
reviewer** loop edits real project files, snapshots them, and can compile and
push them to GitHub and deploy. This repository is the **fully self-hosted
rewrite** — the original Base44 BaaS backend was replaced with plain
Node/Express + Prisma/Postgres. There is **no Base44 runtime dependency** and no
`base44` CLI in this workflow.

**Command Deck / Jarvis** is the product surface; **Morpheus** is the builder it
hands build requests to.

## Stack

| Part | Tech | Where |
|---|---|---|
| Frontend | Vite 6 + React 18, react-router-dom, Radix UI, Tailwind 3, framer-motion, three.js (Matrix theme) | `src/` — deploys to **Netlify**, auto-publishes `main` |
| Backend | Node + Express + Prisma, BullMQ worker, S3-compatible storage, Stripe, nodemailer | `server/` — deploys to **Northflank** (Alpine container) |
| Database | PostgreSQL via Prisma | `server/prisma/migrations/` |
| AI | OpenAI-compatible `/chat/completions`, `response_format: json_object` | `server/src/ai.js` `invokeAI()`; `LLM_MODEL=deepseek-flash`, fallback `gemini-flash-latest`; per-user BYO key supported |

## Key files

- `src/api/base44Client.js` — frontend API client. API base is a **runtime**
  setting (`?api_base=` / localStorage), not build-time.
- `src/lib/AuthContext.jsx` — the other file rewritten from the Base44 original.
- `server/src/routes/` — Express routes.
- `server/src/functions/` — business logic (chat, build loop, compile targets,
  GitHub, marketplace, self-dev).
- `server/src/ai.js` — AI gateway. `server/src/entities.js` — generic entity CRUD.
- `server/prisma/schema.prisma` — data model.
- `base44/` — original entity/function definitions. **Reference only, never
  shipped** (see hazard H7).
- `hosted-broker/` — optional separately-deployed shared OAuth/AI broker.
- `FRESHNESS.md` — model/dependency drift detection (notify-only, never auto-edits).
- `server/PORTING_GUIDE.md` — Base44-API → this-stack mapping.

## Commands

```bash
# Frontend
npm install
npm run dev          # Vite on :5173, proxies /api
npm run lint         # eslint, rules-of-hooks enabled
npm run build        # vite build  (prebuild also runs sync-capabilities + pack-wp-plugin)

# Backend
cd server && npm install && node src/index.js     # port 4500

# Whole stack
docker compose up --build
```

## Verification requirements (from AGENTS.md)

Before finishing code changes, **run the relevant checks**:

- Frontend: `npm run lint` and `npm run build`.
- Backend: no separate lint — verify with a build/bundle check.
- Revert `src/MORPHEUS_DESIGN_PLAN.md` after a build you didn't intend to change (H3).
- Never commit secrets. `server/.env.example` is the authoritative env list.
- Preserve the doc-comment style at the top of most `server/src/` files — match it.

## Self-dev (the in-product loop)

Morpheus can develop **itself** through a singleton admin-only `Project`
(`project_type: 'self_dev'`) that mirrors this repo. The loop is:

sync (pull `main`) → plan/code/review → **verify** (esbuild transform + bundle,
`server/src/functions/verifySelfDev.js`) → **push** (one diff-only commit,
`pushSelfDevToGithub.js`) → **watch** (Northflank poll, auto-diagnose failed
deploys) → **revert** (one-click, `revertSelfDevPush.js`).

**This loop writes to `main` directly and is subject to hazard H9.** If you use
it, resync immediately before the push. See `ROADMAP.md`.
