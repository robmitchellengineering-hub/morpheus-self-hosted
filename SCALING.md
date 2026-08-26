# Scaling Morpheus — from one box to millions of users

This describes how the self-hosted architecture in `server/` and `src/` scales, in the order you'll actually hit each limit. Nothing here requires a rewrite — every stage builds on the last.

## Stage 0 — single instance (docker-compose.yml, as shipped)

One Postgres, one Redis, one backend container, one frontend/nginx container. Good for development, a small team, or a few hundred concurrent users. `STORAGE_DRIVER=local` is fine here — one backend instance means one filesystem, so local disk storage never gets out of sync with itself.

This stage's ceiling is whatever one Node process and one Postgres instance can do — roughly low-thousands of req/s for the CRUD endpoints, and however many concurrent LLM calls your AI provider's rate limits allow (usually the real bottleneck long before Express or Postgres are).

## Stage 1 — stateless API, horizontally scaled

Everything in `server/src/` is already stateless by design: no in-memory session state, no sticky-session requirement (JWT auth, not server-side sessions), no per-process caches that would desync across replicas.

- Run N replicas of the `backend` container behind a load balancer (an ingress controller if you're on Kubernetes, an ALB/NLB on AWS, or nginx/HAProxy on bare VMs). `app.set('trust proxy', 1)` in `server/src/index.js` is already set so `req.ip` and rate limiting behave correctly behind one.
- **Switch `STORAGE_DRIVER` to `s3`** (any S3-compatible bucket — AWS S3, Cloudflare R2, Backblaze B2, self-hosted MinIO) before you add a second replica. Local disk storage breaks the moment two backend instances exist, because a file written by instance A isn't visible to instance B.
- Postgres and Redis stay single-instance at this stage; a managed Postgres (RDS, Cloud SQL, Supabase, Neon) and managed Redis (ElastiCache, Upstash) remove the ops burden here without any app changes.
- Put a CDN in front of the frontend's static assets (`/assets/*` in `nginx.conf` is already cache-forever with content-hashed filenames — any CDN can cache it indefinitely).

This stage comfortably handles tens of thousands of users with normal usage patterns.

## Stage 2 — database scaling

- **Connection pooling**: past a few dozen backend replicas, direct Postgres connections exhaust `max_connections`. Put PgBouncer (transaction pooling mode) in front of Postgres and point `DATABASE_URL` at it instead. Prisma works fine through PgBouncer in transaction mode as long as you avoid prepared-statement-dependent features (Prisma's default query engine doesn't need them for this app's query patterns).
- **Read replicas**: `ProjectFile`/`ChatMessage`/`UsageRecord` reads (file tree loads, chat history, usage dashboards) vastly outnumber writes. Route read-heavy `GET` traffic to a read replica; keep all `/api/functions/*` writes (chat, compile, marketplace) on the primary. This is a `prisma.$extends` read/write client split, not a schema change.
- **Indexes**: `prisma/schema.prisma`'s `@@unique([project_id, path])` on `ProjectFile` already covers the hottest lookup. Add `@@index([created_by_id, created_date])` on `Project`, `ChatMessage`, and `UsageRecord` once list/filter queries show up in `EXPLAIN ANALYZE` as sequential scans — cheap to add via a new Prisma migration, no data migration needed.
- **Partitioning `UsageRecord`** by month becomes worth it once it's the largest table (it grows on every billable action, one row per event, forever). Postgres native partitioning or just periodic archival to cold storage both work; nothing in the app assumes a single physical table.

## Stage 3 — async job offload (the real unlock)

Two endpoints do meaningfully long synchronous work inside an HTTP request today, both flagged in `server/src/queue.js`:

- **`autonomousBuildStep`** (`server/src/functions/autonomousBuildStep.js`) — one iteration of the self-driving build loop; each call is a full planner→coder→reviewer round trip.
- **`getCompileStatus`** (`server/src/functions/getCompileStatus.js`) — polls a GitHub Actions run; the frontend calls this repeatedly during a compile.

At low-to-moderate scale, running these synchronously is simpler and fine. Past that, move them onto the already-wired BullMQ queue (`server/src/queue.js`, `server/src/worker.js`):

1. The route handler enqueues a job and returns `202 { jobId }` immediately instead of blocking.
2. A pool of `worker` containers (already in `docker-compose.yml` under the `worker` profile, scale it independently: `docker compose up --scale worker=8`) picks up jobs and does the actual AI/GitHub-polling work.
3. The frontend polls a `GET /api/jobs/:id` status endpoint (small addition — a `Job` table or just a Redis hash keyed by job id) instead of waiting on the original request.

This is the single highest-leverage change for AI-workload scale: it decouples "how many users are chatting with Morpheus right now" from "how many Node event-loop threads are blocked waiting on an LLM response," and lets you scale AI-processing capacity (worker replica count) completely independently of HTTP-serving capacity (API replica count).

## Stage 4 — protecting the AI/compute budget

- **Per-user rate limiting** on `/api/functions/chatWithMorpheus`, `/autonomousBuildStep`, `/compileProject` specifically (the global limiter in `server/src/index.js` is coarse and IP-based; add a Redis-backed per-`user.id` limiter — `rate-limit-redis` drops into the existing `express-rate-limit` setup — on the expensive routes).
- **Queue depth caps**: reject new `autonomousBuildStep` jobs for a user who already has one in flight for the same project (cheap Redis `SETNX` lock, prevents a runaway client from queuing duplicate work).
- **Cost visibility is already built**: `getUsageStats`/`CREDIT_COSTS` (`server/src/lib/projectUtils.js`) track exactly this — the missing piece at scale is turning it into an enforced quota (reject the request, don't just log it) once a user/org exceeds a configured credits-per-day ceiling. That's a single check added to the top of each AI-calling function, reading the same `UsageRecord` table that already exists.

## Stage 5 — multi-region

Not needed until you have genuinely global, latency-sensitive traffic. When you do: the backend's statelessness means you can run full API+worker stacks in multiple regions pointed at regional read replicas, with a single-region Postgres primary (writes cross-region are rare relative to reads — chat/build is naturally per-user, per-session, not globally hot). GitHub API calls, Stripe, and most LLM providers are already global services, so this stage is mostly "where do the API/worker containers run," not an app-level change.

## What does NOT need to change at any of these stages

- The entity/function contract between frontend and backend (`src/api/base44Client.js` ↔ `server/src/routes/`) — it's already a plain REST API with no server-side session state.
- The compile-target adapter framework (`server/src/lib/compile-targets/`) — GitHub Actions does the actual compute for compiles; this service only orchestrates it, so compile-target scaling *is* GitHub's scaling, not yours.
- Auth — JWT bearer tokens need no sticky sessions or shared server-side session store.
