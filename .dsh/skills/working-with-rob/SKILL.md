---
name: working-with-rob
description: "Who Rob Mitchell is, how he works on Morpheus, and his standing priorities — root-cause before patching, verify claims against reality, no dead ends in the UI. Load before planning work, reporting results, or deciding how deep to verify."
whenToUse: "Load when planning or reporting work for Rob, when tempted to patch a symptom instead of root-causing, when deciding how much verification is enough, or when a change is user-visible."
---

# Working with Rob

Ported from his Claude Code project memory (last modified 2026-09-16).

## Who he is

**Rob Mitchell** — Valiant Music. GitHub `robmitchellengineering-hub`,
business email `info@valiantmusic.com.au`. (Git commits on this repo use
`robmitchellengineering@gmail.com`.)

He is building **Morpheus** (morpheus.nz), a self-hosted AI coding platform, by
**directing an agent to build and self-improve it** — he is not writing the code
by hand. But he is deeply hands-on in *testing*: compiling client projects,
live-testing device flows, reading Admin Panel data, checking production. He
reports **real symptoms, not guesses**, and expects the same in return.

He also runs a real client deliverable on top of Morpheus (the Wikidata Batch
Uploader — see `morpheus-vision`).

## His core standing directive

> **"Getting it right first is the most important thing."**

His own words, given after several rounds of iterative fixes on the Wikidata
uploader where *he* had to spot the pattern before the agent could. He does not
want to be the one who identifies the root cause after three failed attempts.

**How to apply it:**

- **Root-cause before patching.** Use real evidence — Northflank/GitHub Actions
  logs, live DB queries, live API tests — not assumptions about what probably
  went wrong. This is how the OOM crash-loop, the DeepSeek model rename, the
  review-retry cap, the Python syntax-check gap, and the compile poll-timeout
  were all actually found.
- **Verify external claims before depending on them.** Especially package and
  library names and API signatures. Real examples from his history: `ttf-freefont`
  does not exist in Alpine (the real name is `font-freefont`), and
  `wdi_core.WDGlobeCoordinate`'s constructor had to be checked against the
  installed library rather than recalled. Check the live package index or the
  installed source. (This is also hazard H10.)
- **Do a full sweep when touching code.** `grep` for *every* reference to
  something before deleting or renaming it — not just the ones the plan named.
  This caught `core/diagnostics.py`'s hardcoded import-test list.
- **Prefer the real fix over the workaround**, even when the workaround is faster.
- **Report blockers transparently.** If something is broken or blocked — e.g.
  tables that never migrated — say so plainly. Do not silently work around it
  or quietly guess.
- **Recognise patterns and extrapolate the holistic fix**, rather than fixing the
  one instance he pointed at.

## Standing UX rule

> **"Everything must be linked and actionable, no dead ends."**

Any error state a user can reach must offer a real next step — ideally a deep
link straight into the relevant build page ("the Construct" — Rob's term for
`/workspace`) pointed at the specific project and step that failed. A visitor
should never land somewhere with no way forward.

## How he'll judge your work

- Did you find the actual root cause, or stop at the first plausible symptom?
- Did you verify against reality, or reason about what should be true?
- Does the UI actually render correctly, not just compile?
- Is every error path actionable?
- Would he have had to spot something you missed?
