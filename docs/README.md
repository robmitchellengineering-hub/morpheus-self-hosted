# docs — the archive

Two archives live here, and both exist for one reason: **the knowledge in them
was outside git.** The planning corpus sat in `~/Downloads/Build plan 3.0/` and
the audits sat in the DSH session workspace (`~/Documents/DeepSeek/`) — neither
in a repository, both one "empty the folder" away from gone. They are copies, and
the copies here are now the durable ones.

## What these are NOT

**These are point-in-time snapshots, not descriptions of the system.** Every
document below was true when it was written and none of it is maintained. Where
a snapshot disagrees with the code, the code is right — always.

Three sources answer "what is true right now", and each costs one command:

| Question | Command |
|---|---|
| what the system **is** (repo facts, generated) | `node scripts/context.mjs` |
| what is true across **repo + production + deploy + claims** | `node scripts/reality.mjs` |
| what has already **broken** in production | `KNOWN-HAZARDS.md` |

That split is deliberate and it is the same rule the skills follow: rules and
judgement are curated, facts are generated. A dated audit is neither — it is a
record of what someone found on a day, and its value is that it can be re-checked
against the code, not that it stays current.

## docs/planning — the corpus the business decisions were made from

Copied 2026-09-20 from `~/Downloads/Build plan 3.0/`. Dated 2026-08-28 →
2026-09-02. These are the source documents the audits below cite, and the tags
(`BR-v6`, `CP-v6`, `PS`, `TS`, `BS`, `FB`, `TL`) in those audits resolve to files
in this directory.

| File | What it is |
|---|---|
| `docs/planning/BUILD-PLAN-3.0.md` | the phase-by-phase build plan |
| `docs/planning/BUILD-PLAN-2.0.md` | the previous build plan, still cited for Tier 1 |
| `docs/planning/BUSINESS-STRATEGY-TO-ENGINEERING.md` | the three monetisation paths, translated into engineering scope |
| `docs/planning/FEATURE-BACKLOG.md` | the feature backlog items #1–#13, with decisions |
| `docs/planning/TOKEN-SYSTEM-BUILD-PLAN.md` | the 9-step token/billing plan whose status line was false when written |
| `docs/planning/claude_PROJECT-STATUS-2026-08-28.md` | project status, 2026-08-28 |
| `docs/planning/claude_TRADEMARK-LEGAL-FOLLOWUP-2026-08-31.md` | the trademark/legal follow-up |

The polished PDFs (Business Report v6, Competitive Positioning v6, the explainers,
the investor overviews) live beside these in `~/Downloads/Build plan 3.0/` and are
**not** copied here — they are deliverables, and they are regenerated from these
sources. If you clear that folder you lose the renderings, not the substance.

## docs/audits — what was found when the documents were checked against the system

Copied 2026-09-20 from the session workspace. Dated 2026-09-19 → 2026-09-20.

| File | What it is |
|---|---|
| `docs/audits/morpheus-master-backlog.md` | every outstanding item deduplicated out of the five source docs, plus **12 contradictions** between them, plus a list of things explicitly removed from scope so they are not re-added |
| `docs/audits/morpheus-claims-corrections.md` | the four marketing claims that were wrong or understated, with the wording that is true — read this one first |
| `docs/audits/morpheus-marketing-claims-audit.md` | every product, competitor and aspirational claim extracted from the corpus, classified |
| `docs/audits/morpheus-business-model-digest.md` | the financial model, and which numbers are verified vs assumed |
| `docs/audits/morpheus-compile-target-audit.md` | a paper audit of all six native compile targets, and the ranked list of which are most likely to break |
| `docs/audits/selfdev-pipeline-audit.md` | the self-dev delivery engine's safety gates, and the **gaps in them** — several are unenforced policy fields, listed with file and line |

### Open findings in the audits that are not fixed by anything

These are recorded here rather than acted on, and they should not be lost again:

- **`docs/audits/selfdev-pipeline-audit.md`** — `enginePolicy.js` declares
  `allowDirectToMain`, `allowMigrations`, `allowInfraWrites` and
  `maxSpendPerDayUsd` and **nothing reads them**; `pushSelfDevToGithub` accepts
  `body.force` with no policy check; `resolveSelfDevActor` picks any `self_dev`
  project rather than the caller's.
- **`docs/audits/morpheus-compile-target-audit.md`** — `windows-exe` (malformed
  PyInstaller argv) and `rpi-distro` (a dependency install whose failure is
  swallowed) were the two highest-confidence defects.
- **One account sits at −3.77 credits** — a one-row repair, blocked on Rob
  because the migration runner deliberately refuses `UPDATE`.

## The rules these archives taught

The durable lessons were pulled out into the build library rather than left to be
re-read here: `references/reality.md` for the claim-versus-system discipline,
`references/compile-targets.md` for the native-target traps, and
`references/verification.md` for why a check must be able to fail. This directory
is the evidence; the library is the distilled rule.
