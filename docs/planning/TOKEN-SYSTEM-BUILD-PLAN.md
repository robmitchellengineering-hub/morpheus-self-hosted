# Morpheus — Token/Billing System Build Plan

Turns the existing financial strategy (`BUSINESS-STRATEGY.md`'s flat 2× markup model on DeepSeek V4 Pro) into an actual step-by-step engineering plan. Nothing in this doc has been built yet — this is the plan, not a status report.

**Pricing basis this plan assumes** (from `BUSINESS-STRATEGY.md`, verified 2026-08-29 — re-verify at build time since DeepSeek has repriced mid-project before): blended $0.80/M input tokens, $2.40/M output tokens on DeepSeek V4 Pro. Morpheus retail = 2× that = $1.60/M input, $4.80/M output. At exactly 2×, gross profit always equals underlying spend — 50% margin on this line regardless of volume or usage mix.

**Access model: three paths, not two.** (a) Default — pay-as-you-go token blocks on a cheap frontier model (DeepSeek V4 Pro), zero setup required, has to work well out of the box. (b) Guided Free Setup — a walked-through flow for getting the user's own free Gemini API key, replacing today's arrangement where the "free tier" quietly runs on Rob's own personal Gemini account/quota (the root cause of the still-open Gemini 503 congestion issue). (c) Full BYOK — any other provider, existing Custom mode, for users who already have their own key. This replaced the original Free/Pro/BYOK tier structure and removes the need for any Stripe Subscriptions work — see `BUSINESS-STRATEGY-TO-ENGINEERING.md` for the full reasoning.

**Two decisions this plan needed closed — both now decided:**
1. **Pre-call vs. post-call credit check** — **DECIDED: pre-call.** Reserve credits (estimated from prompt length/target) before making the call, reconcile against actual usage once real token counts come back, refund the difference either way. Safer against a user going negative mid-call than post-call deduction.
2. **Owner exemption mechanism** — now effectively decided by the Admin Control Panel discussion (`FEATURE-BACKLOG.md` #8): a real `role` column checked server-side, not a hardcoded email string. Carrying that decision into this plan.

---

## Step 1 — Schema: real usage tracking

Add to Prisma schema:
- A `UsageEvent` (or similar) table: `userId`, `action` (chat/compile/etc.), `modelId`, `inputTokens`, `outputTokens`, `costUsd`, `creditsCharged`, `timestamp`. One row per billable AI call — this is what makes the Cost Tracker and any future billing dashboard actually accurate, replacing the current bucketed-estimate approach.
- Extend `ModelCatalogEntry` (already exists, built for the self-updating model/pricing research system) with: `markupMultiplier` (defaults to 2.0, admin-editable), so pricing isn't hardcoded per-model.
- Add `creditBalance` (or `tokenBalance`) to the user/account table, plus a `billingExempt` boolean or a proper `role` enum (`owner`/`admin`/`user`) — per the Admin Control Panel decision, this should be role-based, not a single hardcoded email. **New**: `creditBalance` defaults to 200 on account creation (the free signup credits, decided 2026-08-31 — see the access-model section below).
- Add a `CreditTransaction` table for token-block purchases (ties into Command Deck's "purchase more tokens" UI later). **New**: needs a `firstPurchase` boolean flag per user (or check `CreditTransaction` count == 0) to know when to apply the signup-credit recoup gross-up — this only applies once, ever, per account.

## Step 2 — Real metering at the call site

Currently: bucketed cost *estimates* per action type (from `costEstimate.ts`), not real usage. Replace with:
- Every call through `invokeAI()` (the core AI pipeline function) captures the actual `usage.input_tokens`/`usage.output_tokens` from the provider's API response — this data is already returned by OpenAI-compatible endpoints, just not currently captured/logged.
- Write a `UsageEvent` row immediately after every completed call, computing `costUsd` from the model's real rate (from `ModelCatalogEntry`) × actual token counts.
- This step alone (metering without enforcement yet) is low-risk to ship first — it makes the Cost Tracker honest without changing anything users experience.

## Step 3 — Billing enforcement (pre-call, decided)

- **Pre-call reserve + reconcile**: before invoking the model, estimate cost from prompt length/target, reserve that many credits (deduct from available balance, hold as a pending reservation), make the call, then reconcile the reservation against actual usage from Step 2 once the real token counts come back — refund the difference if the estimate overshot, or take the small additional amount if it undershot (cap the overshoot risk with a conservative estimate multiplier so users are never surprised by a large true-up charge).
- Either way: a clean `checkAndDeductCredits(userId, estimatedOrActualCost)` function, called from every billable route (chat, compile, GitHub push/import, marketplace publish/install — matching the categories already defined in `usage.js`), returning a clear "insufficient credits" error the frontend can show before/after the fact depending on which mode is chosen.
- Exempt accounts (role-based check from Step 1) skip the deduction but **still get a `UsageEvent` logged** — exempt means "don't charge," not "don't meter," so the Cost Tracker stays accurate for your own usage too.

## Step 4 — Admin-editable pricing (ties directly to Admin Control Panel, `FEATURE-BACKLOG.md` #8)

- Extend the existing admin-triggered model-catalog research system (already built — web search + LLM extraction to keep `ModelCatalogEntry` current) with an admin UI to directly edit: per-model $/M-token rates, the markup multiplier (currently flat 2× — should be adjustable per model or globally), and the credit-to-dollar exchange rate itself.
- This is the natural first real feature inside the Admin Control Panel once that panel exists — rather than building pricing controls as a one-off settings page now and re-homing them later, worth sequencing so the panel's first capability *is* this.

## Step 5 — Priority (Hosted-VM) Compile — **decided: build this, paid in credits**

Today, compile runs free on the user's own connected GitHub Actions minutes. This adds a **paid alternative**: an instant/priority compile option that runs on Morpheus-controlled infrastructure instead, billed in credits at the same 2× markup pattern as everything else, using the per-target cost basis already priced in `BUSINESS-STRATEGY.md`:

| Target tier | Examples | Build time | Blended cost/run | Retail (2×) |
|---|---|---|---|---|
| Light | source, arduino | 1–2 min | ~$0.002 | ~$0.004 |
| Medium | web-app, exe, binary, python | 3–5 min | ~$0.01 | ~$0.02 |
| Heavy | android-apk, linux-distro | 8–15 min | ~$0.02–0.03 | ~$0.04–0.06 |
| Very heavy | rpi-distro (OS image) | 20–60 min | ~$0.05–0.10 | ~$0.10–0.20 |
| Mac-only | mac-app, ios-app | 10–15 min | ~$0.05–0.20 | ~$0.10–0.40 |

**Positioning**: this sits alongside the existing free own-GitHub compile, not replacing it. Free stays free (user's own Actions minutes, $0 platform cost); Priority Compile is the paid upsell — faster, doesn't require the user to have GitHub connected at all, and is a direct extra revenue line (matches the "Priority build queue" line already modeled in the business report's additional-revenue table).

**Mac/iOS signing — decided 2026-08-31: no Morpheus-owned Apple Developer account.** Even under Priority Compile, Mac and iOS targets sign against the connecting user's own Apple Developer credentials, the same pattern as own-GitHub compile using the user's own account. Publishing to the App Store is entirely the user's responsibility. This means Morpheus never needs its own Apple Developer Program membership — it's a genuine $0 line, not a deferred cost. Web apps remain the priority cross-platform target regardless of this decision.

**Implementation approach — two options, recommending the lighter one first:**
- **Option A (recommended to build first): GitHub Actions under Morpheus's own account/org.** Reuses 100% of the existing compile pipeline (`compile.js`, `compileWorkflows.js`, the 11 target adapters) unchanged — the only difference is which GitHub account/org owns the build repo and burns the Actions minutes. Morpheus needs its own GitHub account(s) with Actions minutes purchased/available, and the compile route picks Morpheus's org instead of the user's connection when Priority Compile is selected. Lowest engineering effort — no new infrastructure, just a routing decision plus billing.
- **Option B (heavier, later if Option A's margins or limits become a problem): dedicated VMs/containers.** Real compute provisioning (e.g. ephemeral containers on Northflank or a cloud provider), full custom build orchestration replacing GitHub Actions entirely. Only worth this complexity if GitHub Actions' own usage limits or per-minute costs stop making sense at scale — not needed to ship the feature initially.

**Concrete build steps (assuming Option A):**
1. Set up a Morpheus-owned GitHub account/org with Actions minutes provisioned (billing account separate from any individual user's).
2. Add a `compileMode` parameter (`own-github` / `priority`) to the compile route — when `priority`, target Morpheus's org/repo instead of resolving the user's `GithubConnection`.
3. Apply the same `UsageEvent` + pre-call reserve/reconcile pattern from Steps 2–3, using the per-target cost table above instead of token counts — reserve credits based on target tier before triggering the build, reconcile against actual GitHub Actions billed minutes (or just the fixed estimate, if GitHub's own per-run cost data isn't easily retrievable — flagged as a detail to confirm at build time).
4. Frontend: a "Compile via Priority (X credits)" option alongside the existing free compile button, showing the credit cost per target tier before the user commits.
5. Cleanup: Morpheus's own org will accumulate build repos the same way the per-user disposable `morpheus-build-*` repos already do (see Tier 2 cleanup item in `BUILD-PLAN-2.0.md`) — worth building the bulk-delete/reuse-one-repo pattern into this from day one rather than retrofitting it later.

**Natural extension (separate feature, not part of this step)**: once compile runs on Morpheus-owned infrastructure, a live "Native Preview" of the actual compiled build becomes possible — see `FEATURE-BACKLOG.md` #11. Meaningfully bigger scope than Priority Compile itself (a live interactive VM session vs. a one-shot build job), so treat as a later, separate build phase.

## Step 5b — Guided Free Setup (user's own Gemini API key) — **new, replaces the current shared-Gemini arrangement**

Today's "free" experience actually runs on Rob's own personal Gemini account/API key, shared across every user hitting Default mode — this is the confirmed root cause of the still-open Gemini 503 congestion issue (one account's free-tier quota, hit by everyone at once). The fix isn't a bigger quota or a fallback provider — it's moving each user onto **their own** free Gemini key.

**Note on Google-only sign-in (decided 2026-08-31):** since every account is now created via Google sign-in, step 2 already has the user's Google identity available — this doesn't eliminate the manual key-generation step (Google doesn't issue Gemini API keys via OAuth scope, only through AI Studio directly), but it does mean Morpheus already knows they have a Google account and can skip asking them to sign in again partway through this flow.

**Concrete build steps:**
1. Add an in-app "Get free access" entry point (Settings → AI Provider, or a first-run prompt) — a short explainer that Google's Gemini API has a genuinely free tier, with a link to Google AI Studio (`aistudio.google.com/apikey`).
2. Render step-by-step instructions in-product (not just an external link): sign in with a Google account → create an API key → copy it. A few screenshots or a short numbered list is enough — this needs to be actionable without the user leaving confused.
3. A key-input field in Morpheus, pre-configured for Gemini specifically (not a generic "pick your provider" form like full Custom/BYOK mode) — this should be the easy, guided path, distinct from and simpler than option (c) full BYOK.
4. A test call on submit to confirm the key actually works before switching the account over to "Free (own Gemini)" mode — fail clearly and helpfully if the key's invalid, don't just silently switch modes and let the next real request fail.
5. Once this ships and has real users on it, **retire Rob's own key from the shared-default path** — no more silent platform-wide dependency on one personal Google Cloud account's quota. This directly closes the open Gemini 503 item.
6. Update in-product messaging: the honest pitch becomes "Morpheus is free to use — set up your own free Gemini key and it's genuinely free, all yours, not shared with anyone else's usage."

## Step 6 — Frontend: cost transparency

- Per-action estimated cost shown before running (already a stated design goal in `ROADMAP.md`'s "Cost transparency" item) — once Step 2's real metering exists, this can show an accurate estimate instead of a static bucketed figure.
- Balance/credits display + a **token-block purchase flow** — fixed-denomination one-off Stripe Checkout sessions (no free tier, no subscription; pure pay-as-you-go), reusing the exact Checkout pattern already built and working for marketplace purchases. Exact block sizes/denominations still need deciding (the report's $5/1,000-credit rate is the starting reference point). This is also the same UI surface Command Deck's own token meter (`FEATURE-BACKLOG.md` #9) will need, so worth building this once and reusing it rather than building two separate purchase UIs.
- **Stripe fees passed through to the customer, decided 2026-08-31.** Every checkout price is grossed up so Morpheus nets the full intended block value after Stripe's cut (~2.9% + $0.30/transaction), rather than absorbing the fee out of margin. Formula: `charge = (intended_net + 0.30) / (1 - 0.029)`. Worked examples at the reference denominations:

  | Intended net value | Customer is charged | Stripe takes | Morpheus nets |
  |---|---|---|---|
  | $5 | $5.46 | $0.46 | $5.00 |
  | $20 | $20.91 | $0.91 | $20.00 |
  | $50 | $51.80 | $1.80 | $50.00 |

  This applies to both token-block purchases and marketplace transactions (the 80/20 split is calculated on the intended net value, not the grossed-up charge — so a seller's cut is unaffected by this change, only the buyer's checkout total moves). The exact charge amount needs to be computed live at checkout time against Stripe's real fee schedule, not hardcoded, since Stripe's percentage can vary slightly by card type/region.
- **New-account cold start**: three ways to start now. Guided Gemini setup and full BYOK remain genuinely free (own quota, zero Morpheus cost, no time limit). **New, decided 2026-08-31**: every new account also gets **200 free credits immediately at signup**, no setup step at all — usable on Default mode with zero friction. Worked example: a realistic mix of 5 clarifying chats, 15 real build turns, 2 auto-fixes, a backend plan + generate, 2 test generations, and 3 compiles uses 169 of the 200 credits — enough to fully plan, build, iterate on, and compile one complete small app. Retail-equivalent value: $1.00. Actual platform cost for that realistic mix: ~$0.25 (varies by actual usage — a light chat-only user costs less, a backend-generate-heavy user costs a bit more, ceiling ~$0.35 in the worst realistic case).

  **Recoup mechanism**: this $1.00 signup-credit value isn't written off — it's recovered through the user's first real purchase, not carried as an ongoing giveaway. When a user's free credits run out and they buy their first token block, that specific purchase's intended net value is grossed up by $1.00 before the existing Stripe fee gross-up (Step 6) is applied on top. Example: a $5 block's first purchase becomes a $6.00 intended net, charged as $6.49 after the Stripe formula — versus $5.46 for a normal, non-first purchase. Every purchase after the first reverts to standard pricing, no surcharge.

  **Why this doesn't conflict with the other two free paths**: this is a complement, not a replacement. A user can burn through their 200 signup credits on Default mode with literally zero setup, then decide afterward whether to set up Guided Gemini (free forever), BYOK (free forever, any provider), or just buy their first block (recoups the signup cost as above). No user is ever forced into a purchase decision before they've actually built something real.

## Step 6b — Automated Provider Balance Top-Up (new, decided 2026-08-31)

**The gap this closes**: DeepSeek (like most LLM API providers) runs on a prepaid balance — Morpheus deposits money, usage draws down against it, and if the balance hits zero, every planner/coder/reviewer call fails at once. That's not a degraded experience, it's a total outage for every user simultaneously, and nothing in the plan so far prevents it. Manually watching a DeepSeek dashboard doesn't scale and isn't reliable.

**Why the economics already support this**: Every dollar of DeepSeek cost is billed to users at 2× markup, reserved *before* the call runs (Step 3). Cash collected structurally outpaces cash owed to the provider, as long as the float below is managed — this isn't a feature that has to fight the business model, it's the business model already providing the buffer.

**The real mechanism — not a literal Stripe-to-DeepSeek pipe.** Stripe payouts land with a delay (typically 2–7 business days for a standard account), so "automatically purchase DeepSeek tokens from the Stripe account" can't mean spending today's revenue in real time. The actual design:

1. **A maintained float, not a live transfer.** A business card or bank balance, funded periodically from Stripe payouts, stays topped up with enough runway to cover DeepSeek recharges independent of payout timing.
2. **Balance monitoring.** A scheduled job polls DeepSeek's account balance via their API (needs confirming DeepSeek exposes this — if not, estimate remaining balance from tracked spend against the last known top-up amount, using the real per-call metering already built in Step 2).
3. **Auto-recharge at a minimum-runway threshold**, not at zero. Trigger a top-up when the balance drops below N days of average burn (based on real usage data from Step 2), giving buffer for the recharge itself to process before anything runs dry.
4. **Alerting on failure, not just on low balance.** If an auto-recharge attempt fails (card declined, DeepSeek API issue, float underfunded), this needs to be a critical alert through the error-monitoring tooling already planned (Sentry or equivalent) — a human needs to know *before* the balance hits zero, not after users start reporting failures.
5. **A fallback provider path for the worst case.** If DeepSeek is genuinely unreachable or depleted despite the above, requests should degrade to a fallback provider (Gemini or Groq, both already in the model-routing conversation elsewhere) rather than hard-failing every user's request. This is the same pattern already suggested for the Gemini 503 issue, applied here as the last line of defense.

**Needs deciding later**
- Whether DeepSeek exposes a real balance-check API endpoint, or whether remaining balance needs to be inferred from tracked spend.
- The exact minimum-runway threshold (days of buffer) — needs real usage data from Step 2 before this can be set sensibly rather than guessed.
- Who/what actually authorizes the recharge payment — a stored card on DeepSeek's own auto-recharge feature (if they offer one) is simpler than a custom scripted job hitting their billing API, if available.
- Sizing the maintained float itself — enough to cover a demand spike without waiting on the next Stripe payout cycle.

## Step 7 — Verification

- Test with a real low-cost action (a short chat turn) end-to-end: confirm `UsageEvent` row is accurate against the provider's actual billed usage (cross-check against the provider's own dashboard), confirm credit deduction matches, confirm exempt account logs but doesn't deduct.
- Load-test the credit-check path isn't a bottleneck on the hot path (every chat turn goes through it) — a single indexed lookup should be fine, but worth confirming once built.

---

## Suggested build order

1. Step 1 (schema) — foundational, nothing else works without it.
2. **Step 5b (Guided Free Setup)** — worth pulling forward, ahead of the rest: it's independent of the billing/metering work, directly closes the open Gemini 503 issue, and is pure upside to ship early (mostly UI/copy around existing provider-mode-switch logic).
3. Step 2 (real metering, no enforcement) — safe to ship alone, makes Cost Tracker honest immediately.
4. Step 3 (pre-call reserve + reconcile enforcement) — decision closed, build directly.
5. Step 6 (frontend transparency + purchase flow) — can happen in parallel with Step 3 once Step 2's data exists.
6. Step 4 (admin pricing controls) — sequence as the Admin Control Panel's first real feature, whenever that panel gets built.
7. Step 5 (Priority Compile) — decided go; can be built any time after Steps 1–4 land, since it reuses the same reserve/reconcile pattern.
8. **Step 6b (automated provider balance top-up)** — build this early despite the low number, right after Step 2's real metering exists (needed to set a sensible runway threshold) — a DeepSeek outage from an empty balance is a total-failure risk, not a nice-to-have.
9. Step 7 (verification) — after Steps 2–4 and 6b are live.
