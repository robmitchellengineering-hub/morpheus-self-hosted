# Morpheus — Status & Open Items (2026-08-28)

Consolidated snapshot of where things stand and what's left, combining the last operational review (`claude_HOSTED-MORPHEUS-OPERATIONAL-PLAN-2026-08-27.md`) with what happened in today's session. Read that doc for full detail/history — this is the current punch list plus today's additions.

---

## Open from yesterday's operational review (carried forward, not yet confirmed resolved)

1. **Kimi URL** — still needs Rob's clarification.
2. **Gemini 503s** — running on `gemini-3.5-flash-lite` (free tier, no Cloud Billing linked). Groq fallback or linking real billing are the two real fixes; living with congestion is the third option.
3. **Database password rotation** — flagged as a security follow-up, not done.
4. **TTS timeout fix** — deployed but not smoke-tested (needs a paid custom TTS key configured first).
5. **Bundled template copy parity** (`public/portable-morpheus/_source/src/pages/Settings.jsx`) — decision needed on whether to keep in sync.
6. **Temporary GitHub PAT** — still active as of yesterday, auto-expires Mon Aug 31 2026. Needs revoking (or letting it expire) before/at that date.
7. **No SMTP configured** — email/password signup effectively broken for anyone not using Google OAuth. Needs real SMTP credentials in Northflank.
8. **`portable-architect/` folder incomplete** — needs Rob's call: finish or remove.
9. **URGENT — Stripe not configured on the backend.** No `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` in Northflank env vars. Blocks both the donate widget and marketplace template checkout — marketplace purchases have likely never worked in production because of this.
10. **`donations`, `feedback`, and `updates_plans` Supabase tables** — need the migration SQL (in the operational-plan doc) run against production before those features can save data.
11. **Web hosting for morpheus.nz, $16/year — provider unconfirmed.** Separate from Cloudflare (DNS/registrar) and Netlify/Northflank (actual app hosting). Needs Rob to name the provider so it can be verified and added to the cost tracker.
12. **~62 disposable `morpheus-build-*` repos** on GitHub from one-repo-per-compile-attempt naming — safe to bulk-delete anytime. Separately, worth deciding whether compile should reuse one persistent repo per project instead of minting a new one every attempt (architecture decision, not a bug).
13. **GitHub connection can go stale silently** — Settings/Connections "CONNECTED" only reflects a stored token, not that GitHub still accepts it. Known fix if it happens: disconnect/reconnect GitHub. Not yet fixed at the UI level (would need an active validity check).
14. **Compile-to-GitHub push fix (round 2) not yet confirmed end-to-end** — the structural fix (inline blob content in tree creation, no more read-after-write race) was deployed and confirmed live on Northflank, but hadn't yet been watched through a full compile → completed GitHub Actions build on the new code path.

## Today's session — new finding, not yet resolved

15. **"Failed to create blob for package.json"** — hit while recompiling an *existing* project (not a fresh compile). Likely explanation: recompiling an existing project probably routes through `uploadToGithub.js`'s re-push-to-existing-repo path, which was deliberately left on the old per-file `POST .../git/blobs` loop + `base_tree` merge (the inline-content fix only landed in the fresh-compile, deploy-backend, and github-upload-new-repo paths). Could also be a frontend/backend caching artifact from the iterative fixes.
    - **Status: waiting on Rob to retest in a fresh incognito window** to help isolate frontend caching vs. a real recurrence.
    - **If it recurs**, the follow-up fix is to apply the same inline-blob-content technique to the `uploadToGithub.js` re-push path, the same way it was already done for the other three call sites.
    - Not yet logged as a confirmed bug — pending that retest.

---

## Feature backlog — 5 new items captured this session (not scheduled, no code written)

Full detail in `FEATURE-BACKLOG.md`. Summary:

1. **Community forum** ("The Construct," working name) — Matrix-themed, seeded fake Q&A threads, searchable, Morpheus auto-answers new questions in-character as a fake user.
2. **Download map (Portable Morpheus)** — smaller red dots, seed 623 fake global users as a baseline, real downloads counted on top going forward.
3. **Browser automation agent** — Chrome extension (per-tab opt-in, visible control indicator, kill switch) + integrated in-app browser for mobile, for multi-step/multi-page automated tasks.
4. **"Advanced Mode" in Files panel** — full-featured manual code editor (Monaco/CodeMirror-based) for direct code editing, with open questions around reconciling manual edits with the AI pipeline's view of the project.
5. **Logic Capture** — for the **import** path specifically: when an app imported from another builder (Bubble, FlutterFlow, Base44, etc.) has black-box parts Morpheus can't parse from source, investigate the behavior and rebuild it natively in Morpheus's own stack.

---

## Recommended next steps

1. Rob retests the blob error in incognito → report back whether it recurs, so it can be logged/fixed or closed out.
2. Add the Stripe keys in Northflank (still the top blocker on real money moving through the app).
3. Run the three pending Supabase table migrations.
4. Clarify the Kimi URL issue.
5. Confirm a full compile → GitHub Actions build completes end-to-end on the fixed code path.
6. Revisit the feature backlog whenever ready to schedule any of the 5 items into a BUILD-PLAN phase.
