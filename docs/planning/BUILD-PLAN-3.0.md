# Morpheus — BUILD PLAN 3.0 (2026-08-31)

Reconciles six previously-separate tracking documents that had drifted apart:
- `BUILD-PLAN.md` — the original 8-phase (0–7) build roadmap, written early in the rewrite and never updated since.
- `claude_MORPHEUS-NZ-DEV-CHAT-BACKUP.md` — a chronological session log (Phase 0–12) of what's actually happened.
- `claude_HOSTED-MORPHEUS-OPERATIONAL-PLAN-2026-08-27.md` — the detailed live punch-list, the most accurate source for current open items.
- `TOKEN-SYSTEM-BUILD-PLAN.md` — the step-by-step engineering plan for token metering, pay-as-you-go billing, Priority Compile, and the automated DeepSeek provider balance safeguard.
- `BUSINESS-STRATEGY-TO-ENGINEERING.md` — reconciles `BUSINESS-STRATEGY.md`'s financial modeling into concrete engineering scope.
- `MORPHEUS-COMMAND-GO-TO-MARKET-STRATEGY.pdf` — the growth/user-acquisition plan, absent from 2.0.

Also incorporates findings from `MORPHEUS-OPERATIONS-COST-PLAN.pdf` and `MORPHEUS-COMMAND-INTERNAL-FINANCIAL-REPORT.pdf` (real operating cost, free-tier risk analysis, and the full combined cost stack, 2026-08-31).

**What's new in 3.0 versus 2.0** — three real decisions that existed in the working documents but were never folded back into this master plan: the Stripe fee gross-up mechanism (checkout prices now cover Stripe's cut, not absorbed from margin), the 200 free signup credits with first-purchase recoup, and the automated DeepSeek provider balance top-up (Step 6b) — a genuine outage-prevention safeguard, not a cost-optimization. All three are detailed in Tier 2.5 below.

This doc replaces the need to cross-reference all six for a status check. It's ordered by **usability and profitability impact**, not build sequence — the goal is a clear "what actually matters most right now" picture.

---

## Where things actually stand — live system

- **Repo**: `github.com/robmitchellengineering-hub/morpheus-self-hosted` (private) — the real source of truth.
- **Backend**: Northflank, `morpheus-backend`. **Frontend**: Netlify, `morpheus.nz` / `www.morpheus.nz`. **Database**: Supabase (`morpheus2`).
- **Confirmed built and running**: full chat→plan→code→review→commit pipeline, GitHub OAuth + push/import, 11-target compile pipeline, marketplace (publish/browse/checkout/install, 80/20 split, plus compiled-binary attachment), Architect (backend plan→generate→deploy), diagnosis-role AI routing, all 4 base44 landing-page parity features (donate widget, portable-app download promo, feedback box, Updates Plan tool), default theme redesign with Classic/Clear toggle, Cost Tracker (admin-gated page), per-role AI provider settings, GitHub token silent-refresh.
- **A base44-vs-hosted logic audit** (session Phase 11) found and fixed 5 real regressions: a stale GitHub-connection live-check, a marketplace install-count double-increment bug, two silently-swallowed file-delete errors, a mislabeled money-type in AI-facing docs, and missing backend-deploy env-var fallbacks. All fixed, deployed, confirmed running.

---

## Tier 1 — Immediate blockers (do these first; ordered by impact)

These are the items actively costing money or breaking core usability right now. All require Rob's own hands (credential entry, SQL execution, or a live click-test) — none can be done from inside a Claude session.

1. **Add Stripe keys in Northflank** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — **the single biggest blocker**. Blocks all real money collection: donations and every marketplace purchase. Also the only way to verify the compiled-binary buyer flow end-to-end, since paid checkout has never run against real keys.
2. **Run the 4 pending Supabase migrations** (`donations`, `feedback`, `updates_plans`, `cost_snapshots`) — SQL is written and ready; a safety classifier blocks Claude from running it directly against production. Until run, those features' saved data doesn't persist.
3. **Disconnect/reconnect GitHub once** in Settings → Connections — clears an already-dead token from before the token-refresh fix went live. Without this, GitHub actions may still throw stale "Bad credentials" errors.
4. **Click COMPILE NOW once** on a project that's previously failed, to confirm the round-5 GitHub-push fix (commit `83c6f55`) actually works end-to-end. This is the fix already discussed in this chat re: "Failed to create blob for package.json" — still awaiting your incognito retest.
5. **SMTP** — **decided 2026-08-31 (revised same day)**: not needed after all. Once the Browser Automation Agent (backlog #3) exists, Morpheus can operate its own Gmail account through browser control to send receipts/notifications directly, no paid provider needed. Until that ships, transactional email simply doesn't exist — this is a real dependency between two backlog items, not two independent decisions.
6. **Gemini 503 — resolved by plan, not yet built.** Root cause confirmed: the "free tier" experience runs on Rob's own personal Gemini account, shared across every user, so congestion is everyone hitting one account's free-tier quota at once. Fix: `TOKEN-SYSTEM-BUILD-PLAN.md` Step 5b — a guided in-app flow walking each user through getting their own free Gemini API key, so the shared-quota bottleneck goes away once real users are on it. Not yet built; until then this stays an active reliability issue.
7. **Name the web-hosting provider for morpheus.nz** ($16/yr, unconfirmed) — separate from Cloudflare/Netlify/Northflank — needed so the cost tracker is actually accurate.

## Tier 2 — Confirm & clean up (not blocking day-to-day use, but loose ends)

8. Check the "files failed to load" report Rob saw during a build — direct database inspection is blocked for Claude; needs Rob to check `project_files` in Supabase or point to the specific build log.
9. Publish a template using the new "attach compiled build" checkbox once a real compile succeeds, to dry-run the full seller→buyer path.
10. DB password rotation (security hygiene, not yet done).
11. TTS smoke test (needs a paid custom TTS key configured first).
12. Bundled portable-morpheus template Settings-page parity — decide whether to keep in sync.
13. Temporary GitHub PAT cleanup — **auto-expires Monday, Sept 1 2026** (day after this doc). Revoke or let it expire.
14. `portable-architect/` folder — finish or delete.
15. ~68+ disposable `morpheus-build-*` GitHub repos — safe to bulk-delete. Separately worth deciding: should compile reuse one persistent repo per project instead of minting a new one every attempt?

---

## Tier 2.5 — Monetization Engineering (decided, not yet built)

Full step-by-step detail in `TOKEN-SYSTEM-BUILD-PLAN.md` and `BUSINESS-STRATEGY-TO-ENGINEERING.md`. This sits above Tier 3/4 because it's revenue infrastructure, not enhancement — but below Tier 1 since none of it is a live-site blocker yet. All key pricing-model decisions are now closed:

- **Access model: no free tier, no Pro subscription — pure pay-as-you-go token blocks by default, plus a guided free path.** Default (no setup) runs on a cheap frontier model paid in token blocks. A new **Guided Free Setup** flow walks users through getting their own free Gemini API key — replacing today's arrangement where "free" quietly runs on Rob's own shared Gemini account (the root cause of the Gemini 503 issue in Tier 1). Full BYOK with any other provider remains available too. This removes the need for Stripe Subscriptions entirely; token blocks reuse the same one-off Checkout flow already built for marketplace purchases.
- **Billing enforcement: pre-call reserve + reconcile.** Estimate cost before the call, reserve credits, reconcile against actual token usage once the response comes back.
- **Priority Compile: decided go.** A paid alternative to the existing free own-GitHub compile — instant/priority builds on a Morpheus-owned GitHub org, billed in credits at 2× markup on the per-target cost basis already priced out (light ~$0.004 retail up to mac-only ~$0.10–0.40 retail per run). Recommended build path reuses the existing compile pipeline unchanged, just pointed at Morpheus's own org instead of the user's.
- **Owner exemption**: role column, not hardcoded email — ties into the Admin Control Panel (Tier 4 item #8 below).
- **Math correction (2026-08-31)**: the AI-cost-per-user figure used throughout earlier planning ($0.126/mo) couldn't be reconciled with the platform's own per-action pricing table or the stated DeepSeek rate. Rebuilt from a transparent token-count derivation instead. **Recalibrated again (2026-08-31, same day)**: the usage-profile assumption was then scaled up from a light-usage estimate to a realistic average paying customer — verified figure is now **$1.591/mo ($19.10/yr)** per active user. Combined with Command Deck ($10.58/yr), a user running both lands at **$29.68/yr cost, $59.72/yr retail — just under $5/month**, the deliberate target for this recalibration. This raises every downstream headline figure (profit-per-user-count tables, realistic pay-as-you-go cost) across every Business Report, Investor Overview, Competitive Positioning report, and the new Internal Financial Report / Combined Investor Report — all updated. Full derivation in `TOKEN-SYSTEM-BUILD-PLAN.md`.
- **Tavily removed as a dependency (2026-08-31)**: the model-catalog/connector research capability (web-search-backed price refresh) is now specced as a direct Morpheus capability using its own AI models, not a third-party search API. Removes a previously-unmodeled recurring cost line.
- **New: `MORPHEUS-OPERATIONS-COST-PLAN.pdf`** — a dedicated report answering "can free-tier adoption outpace paid and sink the business." Short answer: no for AI cost (structurally protected via BYOK/Guided Gemini — a free user's AI spend never touches Morpheus's bill), but database/storage growth was flagged as the one real unprotected cost line that scales with total headcount regardless of payment status. See Tier 4 item #12 below for the fix.
- **Google-only sign-in, decided 2026-08-31.** Email/password signup is dropped entirely — Google becomes the only auth method. This unifies sign-in with the Drive storage connection (#12) under a single Google OAuth consent flow, so connecting storage can piggyback on login rather than being a separate step. Two limitations worth flagging: this does *not* extend to Gemini API key setup (Google doesn't issue those through OAuth scopes, so Guided Free Setup stays a distinct, separately-guided step), and it does **not** eliminate SMTP after all — receipts, transaction confirmations, and notifications still need real email delivery, restored as a needed line item (Tier 1 item 5).
- **New cost lines added to the financial model, decided 2026-08-31 (SMTP and Apple Developer reversed same day — see below)**: banking/finance connector costs (Plaid or equivalent, billed at the same 2× markup as AI tokens) and error monitoring (Sentry or equivalent) and product analytics (PostHog or equivalent — also the tool that closes the "no real telemetry yet" gap referenced throughout the cost model) are confirmed real cost lines. **SMTP: not needed** — deferred to the Browser Automation Agent (#3), which will let Morpheus operate its own Gmail account via browser control instead of paying for a transactional email provider. **Apple Developer Program: not needed** — publishing to the App Store/Google Play is the user's own responsibility on their own developer account, same pattern as own-GitHub compile; even Priority Compile for Mac/iOS signs against the connecting user's own Apple credentials. Web apps remain the priority cross-platform target regardless. Full detail in `MORPHEUS-OPERATIONS-COST-PLAN.pdf` and `MORPHEUS-COMMAND-INTERNAL-FINANCIAL-REPORT.pdf`.
- **Stripe fees resolved, decided 2026-08-31 — passed through to the customer, not absorbed.** Every checkout price is grossed up so Morpheus nets the full intended value after Stripe's cut (~2.9% + $0.30/transaction): `charge = (intended_net + 0.30) / (1 − 0.029)`. A $5 token block charges as $5.46; Morpheus nets the full $5. Same mechanism applies to marketplace sales — the 80/20 split still calculates on the intended net value, so a seller's cut is unaffected. This was the last previously-unmodeled cost line; nothing remains unresolved in the cost stack.
- **200 free signup credits, decided 2026-08-31 — the real answer to new-account cold start.** Every new account gets 200 credits immediately at signup, zero setup, usable on Default mode straightaway. Worked example: a realistic mix (5 clarifying chats, 15 real build turns, 2 auto-fixes, a backend plan + generate, 2 test generations, 3 compiles) uses 169 of the 200 credits — enough to fully plan, build, iterate on, and compile one complete small app. Retail-equivalent value $1.00, actual platform cost ~$0.25–0.35. **Not an ongoing giveaway**: this cost is recouped through the user's first real token-block purchase, which gets its intended net value grossed up by $1.00 before the Stripe formula above is applied on top — every purchase after the first reverts to standard pricing. Complements, doesn't replace, the two permanently-free paths (Guided Gemini, BYOK).
- **Automated DeepSeek provider balance top-up, decided 2026-08-31 — closes a real outage risk, not a cost-optimization.** DeepSeek runs on a prepaid balance; hitting zero fails every AI call for every user simultaneously, a total outage. Fix (Token System Build Plan Step 6b, planned not yet built): a maintained float funded periodically from Stripe payouts (not a live transfer — payouts land 2–7 days later), automated recharge at a minimum-runway threshold rather than at zero, critical alerting if a recharge attempt fails, and a fallback provider (Gemini/Groq) as a last resort. The 2× markup already provides the cash buffer for this to work — every dollar of DeepSeek cost is billed to users before the call runs.

**Build order** (full detail in `TOKEN-SYSTEM-BUILD-PLAN.md`): schema + real usage metering → pre-call billing enforcement → **automated DeepSeek balance top-up (Step 6b — sequenced early despite the step number, given the outage risk)** → marketplace refund/seller-verification fixes (parallelizable) → token-block purchase UI (including the 200-signup-credit default and first-purchase gross-up) → Priority Compile → admin pricing controls (as the Admin Control Panel's first feature) → verification pass.

**Still genuinely open**: exact token-block purchase denominations (the report's $5/1,000-credit rate is the reference point, not yet finalized into specific block sizes); whether DeepSeek exposes a real balance-check API endpoint for Step 6b, or whether remaining balance needs to be inferred from tracked spend.

---

## Tier 3 — Remaining structural build (from the original BUILD-PLAN.md phases)

Status of the original 8-phase plan, corrected against what's actually shipped:

| Phase | Status |
|---|---|
| 0 — Scaffold | ✅ Done |
| 1 — Core AI Pipeline | ✅ Done |
| 2 — Diagnosis Agent | ⚠️ Partially confirmed — `role=diagnosis` routing exists in the AI provider system; full `diagnoseIssue`/auto-fix-on-compile-failure behavior not explicitly confirmed built in later session logs. **Worth verifying directly.** |
| 3 — GitHub + Compile | ✅ Done (through 5 rounds of hardening — see Tier 1 item 4 for the one still-unverified piece) |
| 4 — Marketplace | ✅ Done, plus compiled-binary distribution added beyond original scope |
| 5 — Architect | ✅ Done |
| 6 — Frontend Shell | ✅ Largely done — landing, workspace, Architect/Market/Settings pages, theme system all live. PWA installability specifically not confirmed either way. |
| 7 — Polish | ⚠️ Partial — Cost Tracker (UI Polish's cost-transparency goal) is live; Help mode toggle status unconfirmed. |

**Recommended next verification pass**: confirm Phase 2 (diagnosis/auto-fix) and Help mode toggle status directly against the live codebase, since these are the two genuinely uncertain items left in the original structural plan.

---

## Tier 4 — Feature backlog, ordered for usability & profitability

Full detail for every item below lives in `FEATURE-BACKLOG.md` (12 items). This is that same list, re-ordered by expected impact-per-effort rather than the order ideas came up in conversation:

1. **#8 Owner/Admin Control Panel** — highest profitability leverage relative to effort: model/margin control, monitoring, and general backend management all in one place. Also the natural home for keeping AI pricing current without manual re-verification each time a model reprices.
2. **#7 "Boring" theme** — cheap to build, directly widens the addressable market (older users, corporate/office buyers who'd otherwise bounce off the Matrix aesthetic). Fixed on/off toggle, no theming-system overhead.
3. **#12 User-choice cloud storage for project data** — ranked high despite being a newer idea because it closes a real, currently-unprotected cost risk before it becomes one: database/storage growth scales with total headcount (free and paid alike) with no structural protection today, unlike AI cost. Worth doing before free-tier adoption scales, not after — same logic as fixing Gemini 503 before it got worse.
4. **#6 Post-deployment user management** — supports retention and perceived professionalism for paying users who've deployed real apps; both the operational-health side and the end-user-management side.
5. **#1 Community forum ("Zion Forum")** — reduces support burden at scale via searchable seeded Q&A, and gives new users a reason to stick around before they've built anything yet.
6. **#2 Download map polish (Portable Morpheus)** — cheap, cosmetic, but directly supports landing-page trust/conversion via a populated-looking global user base.
7. **#4 "Advanced Mode" code editor** — power-user retention feature; keeps advanced users from feeling boxed in by the chat-only flow.
8. **#5 Logic Capture** — meaningful competitive differentiator specifically for the import path (Bubble/FlutterFlow/Base44 migrations), moderate build effort.
9. **#3 Browser automation agent** — high differentiator potential but the heaviest build-and-security-review item of the near-term features; a genuinely separate subsystem.
10. **#9 Command Deck** — the single biggest bet in the backlog: effectively a second product surface (Jarvis, cross-domain life/business synthesis, its own marketplace). Highest long-term differentiation potential in the whole backlog, but also the largest scope, most new infrastructure (connector ecosystem, storage-provider choice, inter-agent communication), and the one item that most benefits from being deliberately scoped down before a first build attempt rather than built all at once.
11. **#10 Jarvis Specialist Modes** — sequenced after Command Deck since it depends on Jarvis existing at all. Doctor and lawyer modes are excluded for now pending legal review (see the trademark/legal follow-up doc); every other profession (trades, engineering, science, software, business/strategy) is in scope and unblocked.
12. **#11 Native Preview (paid)** — builds directly on Priority Compile (Tier 2.5) once that's live: a paid, live/interactive preview of the actual compiled native build (streamed from a hosted VM/emulator), not just the existing web prototype view. Sequenced after Priority Compile since it depends on that infrastructure existing first, and is meaningfully bigger scope on its own (an ongoing VM session vs. a one-shot build job).

**Also outstanding, not yet actioned**: the trademark/legal follow-up (`claude_TRADEMARK-LEGAL-FOLLOWUP-2026-08-31.md`) — worth resolving in parallel with the above, not blocking build work, but genuinely worth not leaving indefinitely given how much is being built under the Morpheus name.

**New (2026-08-31): `MORPHEUS-COMMAND-GO-TO-MARKET-STRATEGY.pdf`** — every financial document up to this point modeled profit at various user counts without ever addressing how those users arrive. This new document, grounded in real growth data from Lovable ($500M ARR, 8M users, zero paid acquisition until past $300M ARR) and Base44 ($80M acquisition, 400K users, zero paid acquisition ever) — the two closest real comparables — lays out a six-channel plan built almost entirely on capabilities already in the backlog or already shipped (marketplace/template cloning, Zion Forum as SEO infrastructure, Logic Capture as direct competitor-poaching, Command Deck as a daily-use funnel back to Morpheus) plus one channel that requires founder commitment rather than engineering (build-in-public). Phased from 0 users to 100,000+, with paid acquisition deliberately held back until organic growth is proven — the same discipline both comparables used.

---

## The one-paragraph version

Hosted Morpheus is functionally complete for its original scope — the core loop, compile pipeline, marketplace, and Architect all work. What's standing between here and "actually making money reliably" is entirely in Rob's hands: Stripe keys, four SQL migrations, one GitHub reconnect, and one confirmed compile. Once Tier 1 is clear, the app is genuinely operational end-to-end. Sitting right behind that: real monetization engineering, now fully decided and cost-verified end to end — pay-as-you-go token blocks with 200 free signup credits, no free tier or subscription, BYOK/Guided Gemini as the permanent free paths, pre-call billing with Stripe fees passed through rather than absorbed, a new paid Priority Compile feature, and an automated DeepSeek balance safeguard to prevent the one failure mode that would take the whole platform offline at once. The per-user AI cost figure was audited, corrected, then deliberately recalibrated to a realistic paying-customer profile (combined Morpheus + Command Deck usage now lands just under $5/month, by design). A dedicated Operations Cost analysis confirmed the free tier can't sink the business on AI cost (structurally protected) and identified the one real remaining risk (storage growth), which now has a concrete fix on the backlog (#12). A Go-To-Market strategy, grounded in real data from the two closest comparable companies, finally addresses how users show up in the first place — something every prior financial document assumed without explaining. Everything past that is enhancement — quick wins first (Boring theme, admin panel, storage architecture, user management, forum), then the two biggest bets (Logic Capture and Command Deck) whenever there's appetite for a larger build.
