---
name: morpheus-vision
description: "The deferred Jarvis↔Morpheus vision — dynamic widgets and connections, the two restricted self-dev modes, Marketplace distribution, and auto-deploy constraints. Load before any Jarvis-driven build or inter-agent work, to avoid opportunistic implementation."
whenToUse: "Load when a task touches Jarvis-driven builds, dynamic Deck widgets, custom connections, Deck widget distribution/sales, auto-deploy, or any Jarvis↔Morpheus inter-agent idea."
---

# Jarvis ↔ Morpheus vision

Ported from Rob's Claude Code project memory (last modified 2026-09-17).

**This is not a backlog item. It is unstarted, unscoped, and explicitly must not
be implemented opportunistically inside an unrelated Deck PR.** It needs its own
scoping pass first. This skill exists so an agent recognises when a task is
brushing against it and stops rather than starting it.

## The vision (Rob's stated long-term direction)

- **A fully customizable personal assistant** — not a Valiant-Music-specific
  hardcoded build. Everything shipped so far is his own first working example.
- **Jarvis and Morpheus talk to each other and know each other's abilities**, so
  they work together rather than being two isolated agents sharing a codebase.
  No inter-agent messaging or API exists between `chatWithJarvis.js` and
  `chatWithMorpheus.js` today.
- **Morpheus writes custom widgets for Command Deck** that synthesize data across
  whatever connections the user has set up.
- **If a needed connection doesn't exist, Morpheus can add one** — the build loop
  becomes the mechanism for extending Jarvis's data reach, rather than a fixed,
  hand-coded connector list.

## The key architectural finding (confirmed, not yet acted on)

**Most of this already exists.** The repo has a working self-dev pipeline for
exactly the "Morpheus writes a widget" half:

`planSelfDevFeature.js` (breaks a described feature into shippable steps) feeds
`chatWithMorpheus.js`'s normal planner/coder/reviewer loop, which already knows
how to push to GitHub (`pushSelfDevToGithub.js`), merge a PR
(`mergeSelfDevPr.js`), run migrations (`applySelfDevMigrations.js`), and verify
(`verifySelfDev.js` / `smokeCheckSelfDev.js`) — **against morpheus-self-hosted's
own repo, which is where Command Deck itself lives.**

So "Jarvis builds a custom widget" is very likely **wiring Jarvis into this
existing pipeline scoped to Deck**, not inventing a dynamic-codegen system from
scratch. All those self-dev functions are currently admin-only (`ADMIN_FUNCTIONS`
in `functions.routes.js`).

## The two restricted modes (Rob's scoping model, confirmed 2026-09-17)

Self-dev triggered **through Jarvis** runs in one of two fenced modes:

| Mode | May only touch |
|---|---|
| **widget-build** | Command Deck's widget section — new widget files plus registering them, e.g. in `deckWidgets.js` |
| **connection-build** | A "custom connections" section — **does not exist yet**; today's Connections section only lists known hardcoded providers |

Neither mode may touch anything outside its own lane.

Self-dev triggered **by Rob directly through Morpheus** (the existing admin path)
is **completely unchanged** — full, unrestricted repo access. His framing:
*"leveraging self-dev's power and putting a small portion of it in the hands of
users"* — not building a second, separate system.

## Auto-deploy: approved, but the enforcement doesn't exist yet

**Approved:** auto-deploy without a human merge-click is fine **when the change is
scoped to widget-only edits** — constraining it to new widget files plus their
registration keeps the blast radius small enough.

**But:** the mechanism to *enforce* that scope is **not built**. Today's self-dev
coder can edit anything in the repo. Until an allow-listed-paths (or similar)
constraint exists and is enforced **server-side — not merely prompted for** —
"auto-deploy is low-risk" is an assumption, not a fact. Do not treat it as true.

**Unsettled:** whether new OAuth *connections* (new Prisma model + migration +
OAuth routes — a materially bigger blast radius) also auto-deploy or need human
review.

## Marketplace distribution

Users write Deck widgets **inside Morpheus** and sell/distribute them on the
existing Marketplace (`/market`, `StoreItem.jsx`, the Template system).

**A Deck widget does not distribute like a normal template.** A template buyer
gets their own project/codebase copy. A Deck widget buyer gets it **installed
into their own running Command Deck**. Likely mechanism (not designed): the
widget's code merges into the shared runtime once published — this is one shared
morpheus-self-hosted deployment — and "install" for a buyer is really creating
their own `DeckWidgetInstance` row for that `widget_key`. Gating rendering/use,
not code delivery.

Needs a real purchase/ownership record tying a widget to who may enable it,
probably against the existing credit/Stripe system.

## Self-service authoring: zero manual steps, humans only on failure

For a regular user building their own widget, plan → code → review → deploy must
require **no manual steps when it succeeds**. On failure, Command Deck must show
a **real, actionable error state** — a link straight into the relevant Morpheus
build page ("the Construct" — Rob's term for `/workspace`, the project chat/build
UI) pointed at the specific project and step that failed.

This is the concrete application of his standing UX rule: **"everything must be
linked and actionable, no dead ends."**

## What this vision requires (a scope statement, not a status report)

None of the following is designed or built. They are listed as the *work this
vision entails* so anyone approaching it knows the shape — not as a progress
tracker. **If you need to know whether one has since been built, check the
code.** A snapshot here would be wrong within days, which is exactly what
happened to `morpheus-deck`'s hand-written "shipped" list.


- The technical mechanism for the two restricted modes (allow-listed paths passed
  into the coder role, enforced server-side).
- A real "custom connections" section and data model for connection-mode to
  target.
- The marketplace purchase/install data model for Deck widgets.
- Wiring Jarvis's own chat into `planSelfDevFeature.js` (today it's triggered
  from a project's own build chat).
- The error-state UI and deep link from Command Deck into a failed build.

## Related

- `morpheus-deck` — what's actually shipped, and the own-data architectural rule.
- `morpheus-dev-protocol` — how changes ship.
- `docs/planning/FEATURE-BACKLOG.md` #9 — the original "Command Deck Marketplace / Jarvis↔Morpheus
  inter-agent communication" note this whole feature traces back to. The planning corpus is
  archived in `docs/` (`docs/README.md`) because it used to live only outside the repo.
