# Morpheus — Roadmap

_Last updated: 2026-09-09_

The active planning doc is **Command Deck 4.0** (kept outside the repo). This
file tracks the two threads that live in the codebase: making **self-dev**
capable of replacing the manual dev loop, and native **live-preview hosting**.

---

## Self-dev — replace the dev loop

Goal: develop Morpheus inside Morpheus's own chat/plan/code/review workspace
instead of an external editor + git + local testing. Self-dev is a singleton
admin-only `Project` (`project_type: 'self_dev'`) that mirrors this repo.

**Loop today:** sync → plan/code/review → verify → push (→ PR → auto-merge on green checks) → watch → revert

| Tier | Item | Status | Where |
|---|---|---|---|
| 1.1 | Pre-push verification (esbuild transform + bundle from real entry points) | ✅ done | `server/src/functions/verifySelfDev.js` |
| 1.2 | Push to a branch + auto-merge on green verify (instead of straight to `main`) | ✅ done | `server/src/functions/pushSelfDevToGithub.js` (PR branch), `server/src/functions/mergeSelfDevPr.js` (poll checks + squash-merge) |
| 1.3 | One-click revert of the last push (tree-swap, 409 guard if `main` moved) | ✅ done | `server/src/functions/revertSelfDevPush.js`, `server/src/lib/github.js` `revertCommit` |
| 1.4 | Auto-diagnose failed deploys (poll Northflank, pull logs into a fix turn) | ✅ done | `src/pages/SelfDev.jsx` deploy watcher |
| 2.5 | Repo research pass before planning (iterative investigate loop, ≤16 files / ≤3 rounds) | ✅ done | `server/src/functions/chatWithMorpheus.js` `researchRepo()` |
| 2.6 | Diff-based edits — coder returns `edits:[{find,replace}]`, no-op on ambiguous/missing match | ✅ done | `server/src/lib/projectUtils.js` `applyEdits()` |
| 2.7 | Decisions log — each self-dev change records what changed and why; planning reads it back | ⬜ | — |
| 3.8 | Real branch preview — wire PreviewPanel to the Netlify per-PR deploy preview instead of the LLM mockup | ⬜ | Netlify already builds `deploy-preview-<N>--morpheus-self-hosted-app.netlify.app` |
| 3.9 | Auto test-generation per change | ⬜ | — |

**Supporting pieces already shipped:** GitHub Device Flow connect (mobile-safe),
CONTEXT ⇄ BUILD chat mode (instant-reply vs full pipeline, platform-wide),
scoped repo context above 120 KB, collapsible mobile toolbar.

### v2 — beyond edits, toward building features

| Item | Status | Where |
|---|---|---|
| **Known-hazards doc** — `KNOWN-HAZARDS.md` of past self-inflicted breakage; planner won't repeat one, reviewer flags a regression against it as critical; `revertSelfDevPush` + failed-deploy diagnosis append new incidents | ✅ done | `KNOWN-HAZARDS.md`, `chatWithMorpheus.js` (orientation), `reviewer.js` |
| **Post-deploy smoke check** — after a green deploy, black-box the live API/auth/functions/frontend; a failure opens the same fix turn a failed deploy does | ✅ done | `server/src/functions/smokeCheckSelfDev.js`, `SelfDev.jsx` |
| **Persistent feature plans** — a multi-step feature tracked across turns (plan + per-step status); planner gets the goal + steps + active step every build turn | ✅ done | `SelfDevFeature` model, `server/src/functions/{plan,update,get}SelfDevFeature*.js`, `server/src/lib/selfDevFeature.js`, `SelfDevFeatureModal.jsx` |
| **DB migrations** — a `schema.prisma` change ships a `server/prisma/selfdev-*.sql` in the same change (push blocked without one); additive DDL is applied to the DB automatically after the merge, risky DDL is flagged for a human | ✅ done | `server/src/lib/selfDevMigrations.js`, `server/src/functions/applySelfDevMigrations.js` |
| **Caller-impact review** — `verifySelfDev` fails on a named import of a local file the file doesn't export (the github.js incident class, deterministic); the reviewer gets a CALLER IMPACT manifest for every changed shared file | ✅ done | `server/src/lib/importGraph.js` |
| **Backend change preview** — run a changed function in a rolled-back transaction against real data | ⬜ next | — |

See `SELF-DEV-V2-AND-PLUGIN.md` (kept outside the repo) for the full analysis, incl.
the "Morpheus as an embeddable plugin" product idea and a `shared-engine` extraction
that de-risks it.

---

## Native live-preview hosting (cloud emulators + streaming)

**Status:** researched, tabled.

**Goal:** live preview of native builds (Android APK, iOS app, desktop binaries,
Arduino firmware) — the actual compiled artifact running on cloud infra and
streamed to the operator's device, not a web mockup.

**Why:** the current rapid-prototype system generates a web mockup (good for
UI/UX feedback) but can't show real native rendering, platform APIs, sensor
behaviour, or true performance.

**Researched options:**

- **Android:** Genymotion SaaS (WebRTC), headless Android emulator on a cloud GPU
  VM (AWS Device Farm / Firebase Test Lab), Appetize.io (in-browser, freemium),
  BrowserStack App Live.
- **iOS:** Corellium (cloud ARM VMs running real iOS, WebRTC), MacStadium / EC2
  Mac with Xcode simulators, Appetize.io.
- **Desktop:** cloud Windows VMs (Azure, AWS WorkSpaces) with remote-desktop
  streaming, Parsec / Moonlight for low-latency GPU streaming, Wine + Xvfb for
  Windows `.exe` preview on Linux.
- **Embedded:** Wokwi / SimAVR (browser AVR simulator), QEMU for ARM firmware.

**Proposed architecture:** after GitHub Actions compiles the binary, push the
artifact to a preview host → boot the right emulator/VM → install → open a WebRTC
stream embedded in PreviewPanel with touch input forwarded → "Stop Preview"
tears the instance down (per-minute billing, auto-shutdown on inactivity).

**Next step:** Appetize.io integration (Android + iOS, instant, freemium) as a
proof-of-concept, then evaluate Corellium for full-device fidelity.
