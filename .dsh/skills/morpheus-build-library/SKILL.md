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
| write or review a **test, harness or CI guard** | `references/verification.md` | the bar ("it builds" is not verification), designing a guard that can actually fail, mutation testing, harness fidelity, shell traps |
| touch the **WordPress plugin** or its endpoints | `references/wordpress.md` | plugin lifecycle and the update channel, install quirks, "too old" answers two ways, proven secrets, the theme export, cache and content rules |
| add or change an **AI-backed feature** | `references/ai-features.md` | model output as untrusted input, response shapes with no field for an invented number, grounding from the system, billing and prompt hygiene |
| build **onboarding, a wizard or a first-run path** | `references/onboarding-ux.md` | probe-driven steps, idempotent "ensure" functions, preserving intent through login, checklists with live state, being honest about platform limits |
| change **SEO behaviour or metadata** | `references/seo.md` | the duplicate-tag rule, who owns the head, templates, what an audit is allowed to claim, safe internal linking |
| fight the **environment or tooling** | `references/tooling.md` | background-job and pkill traps, browser-automation traps, GitHub token scopes, Playground boot timing, macOS gaps, edits that abort partway |

Two things that are not cards, because they already exist and are maintained
elsewhere:

* **What has already broken in production** — `KNOWN-HAZARDS.md` (H1–H12) and the
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
