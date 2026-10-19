# Keeping Morpheus current

Morpheus checks itself for two kinds of drift on an ongoing schedule:

1. **AI model staleness** — is the configured AI model still the newest
   available for its provider?
2. **Dependency staleness** — are `server/package.json` or the root
   `package.json` (the frontend) pinned below what's currently published
   on npm?

## The design boundary

This system **detects and notifies. It does not self-modify.** It never
edits `package.json`, never runs `npm install`, never opens a pull request,
never redeploys anything — on its own initiative — as part of this check.

That's a deliberate choice, not a missing feature:

- **Supply-chain safety.** Auto-pulling "whatever npm currently calls
  latest" on a timer means an unreviewed — possibly compromised, possibly
  just broken — package version lands in a codegen platform automatically.
  Morpheus generates and hosts other people's projects; a bad auto-bump
  here doesn't just break Morpheus, it can break every app built with it.
- **Every self-hosted instance carries real user projects.** A framework
  or dependency bump that looks safe in isolation can break in-flight
  compiles, generated code that assumed an older API shape, or a
  deployment pipeline that hasn't been touched in months. That needs a
  human (or at minimum a reviewed PR + CI run) in the loop, not a cron job.

The one thing this system automates fully — **AI model selection** — is
the exception, and it's exempt from both risks above: it's runtime config,
not code; a bad model swap is instantly reversible (flip `LLM_MODEL` back,
or a provider-side rollback); and providers who offer a stable alias for
this (Google's `gemini-flash-latest`) have already done the safety
engineering on their end. See `server/src/ai.js` and `server/src/
freshness.js::discoverLatestModel`.

## What actually happens automatically

- **AI model**: leave `LLM_MODEL` (or a per-role override, or a user's
  custom model in Settings → AI Provider) blank, `auto`, or `latest`, and
  `invokeAI()` resolves it fresh every time it's needed — via a provider's
  official "-latest" alias when one exists (Gemini), or by querying that
  endpoint's own `/models` list and picking the newest chat model
  otherwise (cached 12h so this doesn't add a network round-trip to every
  single AI call). No admin action needed, no restart needed.
- **Freshness report**: runs on a schedule (`FRESHNESS_CHECK_INTERVAL_MS`,
  default 24h) and, only when the report has *changed* since the last run
  (so an unattended weekly schedule doesn't spam the same "3 packages
  outdated" email forever), sends a summary to `FRESHNESS_NOTIFY_EMAIL`
  via the existing SMTP config. Always readable on demand at
  `GET /api/admin/freshness` (admin JWT required), and force-refreshable
  at `POST /api/admin/freshness/refresh`.

## What a human still does

Reviewing the report and deciding what to act on: bump a dependency (and
run the test suite / a build before shipping it), pin an AI model instead
of tracking "latest" if stability matters more than currency for a given
deployment, or ignore an item that doesn't matter yet. The report is the
prompt for that decision, not a replacement for it.

## Where the code lives

- `server/src/freshness.js` — the checks themselves (`discoverLatestModel`,
  `checkNpmDependencies`, `runFreshnessCheck`, `runFreshnessCheckAndNotify`).
- `server/src/ai.js` — uses `discoverLatestModel` for live AI calls.
- `server/src/freshnessSchedule.js` / `server/src/worker.js` — the
  schedule: in-process on a single-instance self-host (no Redis), or a
  BullMQ repeatable job owned by the worker process once `REDIS_URL` is
  set (so it runs exactly once regardless of API replica count).
- `server/src/routes/admin.routes.js` — the `GET`/`POST /api/admin/
  freshness` endpoints.

## Extending it

Two natural next steps, not built yet because they need a decision this
doc can't make for you: whether template/scaffold defaults for new
Morpheus projects (framework versions baked into `templates` entities)
should be part of this report too, and whether the report should feed a
GitHub Actions check that opens a draft PR for a dependency bump — a
human still merges it, but the diff is prepared automatically. Both are
straightforward additions to `freshness.js` if/when wanted.
