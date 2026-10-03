---
name: morpheus-build-library
description: "The index of Morpheus build knowledge — how to verify a change so it can actually fail, the WordPress/plugin domain rules, how to treat model output, the onboarding patterns, and the tool traps that have cost time here. Load this when a task touches something you have not done in this repo before; it points at one short card per topic rather than carrying it all in context."
whenToUse: "Load when starting work in an unfamiliar area of morpheus-self-hosted, when writing or reviewing a guard/verification, when touching the WordPress plugin or its onboarding, when adding an AI-backed feature, or when something behaves in a way the code does not explain."
---

# Morpheus build library

A hub, not a textbook. Each card below is short, actionable, and points at the
check that enforces it — read the one card you need instead of loading all of
this into context.

**How to use it:** find the row that matches what you are about to do, read that
card, then get on with the work. If a card is wrong, fix the card in the same
branch as the change that proved it wrong — a library that lags the code is worse
than none.

| If you are about to… | Read | It covers |
|---|---|---|
| write or review a **test, harness or CI guard** | `references/verification.md` | the bar ("it builds" is not verification), designing a guard that can actually fail, mutation testing, transitive purity, removing behaviour that passes every gate |
| touch the **WordPress plugin** or its endpoints | `references/wordpress.md` | plugin lifecycle and the update channel, install quirks, "too old" answers two ways, proven secrets, never self-updating through Deploy, the parsed JS↔PHP contract, the theme export |
| **find a screen someone described** ("the SEO tab in the plugin") | `references/surfaces.md` | the four surfaces and which one you are in, the dock-vs-WordPress-plugin naming trap, which tab components two surfaces share, why the dock has no SETUP tab, scope gating |
| add or change an **AI-backed feature** | `references/ai-features.md` | model output as untrusted input, response shapes with no field for an invented number, silent truncation read as a negative answer, grounding, billing and prompt hygiene |
| build **onboarding, a wizard or a first-run path** | `references/onboarding-ux.md` | probe-driven steps, idempotent "ensure" functions, preserving intent through login, live-state checklists, a failed load never rendering as an empty account |
| change **SEO behaviour or metadata** | `references/seo.md` | the duplicate-tag rule, who owns the head, templates, what an audit is allowed to claim, safe internal linking |
| work on **traffic, indexing, or the TRAFFIC tab** | `references/traffic.md` | a submission is not an index (200 vs 202), the ledger as the only evidence, why submission lives on the site and backfill in the app, idempotent buttons, one shared component in both surfaces |
| touch a **compile target or native delivery** | `references/compile-targets.md` | why a paper audit is not evidence, `\|\| true` on a dependency install, PowerShell argv splatting, artifacts keyed on the wrong thing, macOS signing |
| **decide whether something is actually true** | `references/reality.md` | rules vs facts vs claims, `scripts/reality.mjs`, the 13 drifted planning docs, checking a punch-list item before acting on it |
| **work out what the system is doing right now** | `references/observability.md` | the container's own log vs the app's log reader, failed-read-vs-empty-state, counter semantics, what a session costs |
| **connect a third party** (Google, GitHub, pairing) | `references/connections.md` | OAuth callbacks outside `requireAuth`, requesting the scope that returns the data you persist, never guessing an account, scope boundaries |
| fight the **environment or tooling** | `references/tooling.md` | background-job and pkill traps, browser-automation and sandbox traps, GitHub token scopes, Playground boot timing, macOS gaps, edits that abort partway |

Two things that are not cards, because they already exist and are maintained
elsewhere:

* **What has already broken in production** — `KNOWN-HAZARDS.md` (H1–H21) and the
  `morpheus-hazards` skill. Read that before proposing anything risky; this
  library is about how to build, that list is about what has already cost us a
  night.
* **What the system is right now** — `node scripts/context.mjs` for facts, and
  `node scripts/sessions.mjs "<query>"` for why a past session did something.

**The one rule that matters most, if you read nothing else:** every lesson here
became durable by turning into a check. A lesson in a commit message gets read
once; a lesson in `scripts/verify-*.mjs` runs on every pull request. When you
learn something, put it where it will be executed, and only then write it down
here.
