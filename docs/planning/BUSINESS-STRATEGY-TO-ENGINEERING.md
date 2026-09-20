# Morpheus — Business Strategy → Engineering Reconciliation

Goes through every line item in `BUSINESS-STRATEGY.md` (the financial/costing/tier doc — currently only living as a session output, not yet in project files, worth uploading) and translates each into what actually needs to be built. `TOKEN-SYSTEM-BUILD-PLAN.md` already covers the metering/billing-enforcement engineering in detail — this doc references that one rather than repeating it, and covers everything else in `BUSINESS-STRATEGY.md` that doesn't have an engineering plan yet.

---

## 1. Default AI metering, pricing, enforcement → already planned

Covered in full by `TOKEN-SYSTEM-BUILD-PLAN.md` (7 steps: schema → real metering → billing enforcement → admin pricing controls → compile billing → frontend transparency → verification). Nothing to add here — just confirming this line item isn't orphaned from the rest of the strategy doc.

## 2. Pricing model → **decided: no free tier, no Pro subscription — pure pay-as-you-go token blocks, plus a guided free path**

Supersedes the Free/Pro/BYOK tier structure originally in `BUSINESS-STRATEGY.md`. Three distinct paths now, not two:

**a. Default (no setup required)** — pay-as-you-go token blocks on a cheap frontier model (DeepSeek V4 Pro, per the cost basis already used throughout `TOKEN-SYSTEM-BUILD-PLAN.md`). This has to work well out of the box with zero configuration — the "just start typing" experience for anyone who doesn't want to set anything up.

**b. Guided Free Setup — user's own free Gemini API key (new, replaces the current shared-Gemini arrangement).** Today's "free tier" experience actually runs on Rob's own personal Gemini account/API key, shared across every user — this is the root cause of the still-open Gemini 503 issue (one account's free-tier quota, congested by everyone using it at once). The fix: **a guided, actionable in-app flow that walks each user through getting their own free Gemini API key**, so every user has their own Google-provided free quota instead of sharing Rob's. This becomes the genuinely-free, zero-Morpheus-cost path — "free, all yours," not "free because Rob is quietly paying for it."
  - Concrete flow: an in-app "Get free access" option → short explainer + link to Google AI Studio (aistudio.google.com/apikey) → step-by-step instructions rendered in-product (sign in with a Google account, create a key, copy it) → paste the key into Morpheus → a test call to confirm it works → account switches to running on the user's own Gemini key.
  - This should be easier and more guided than raw BYOK — raw BYOK (option c below) assumes the user already knows how to get an API key for whatever provider they want; this flow specifically holds their hand through the one provider (Gemini) that has a real, generous free tier worth pointing people at.
  - Once this ships, retire the current setup (Rob's own key powering a shared "default" for everyone) — no more silent platform-wide dependency on one personal Google Cloud account's quota.

**c. Full BYOK (existing)** — any other provider, for users who already have their own key and want a specific model, via the existing Custom mode in `lib/ai/llm.ts`. Unchanged.

**Engineering implications, still holding from before:**
- **No Stripe Subscriptions needed at all** for path (a) — token blocks are one-off purchases, same Checkout pattern as marketplace.
- **No monthly credit-reset job** — nothing recurring to reset.
- **Schema**: still no `tier` field needed for billing — "which of the three paths a user is on" is really just which AI-provider mode is active (Default/Gemini-guided/Custom), not a billing tier.
- **Block sizes**: still need deciding (the report's $5/1,000-credit rate is the reference point).
- **New item**: a short onboarding UI for the Gemini guided-setup flow (b above) — copy, screenshots/steps, a key-input field, and a test-call verification step before switching modes. Smaller build than it sounds, since it's mostly UI/copy wrapped around the AI-provider-mode-switch logic that already exists.

## 3. Marketplace trust features → flagged as unbuilt in BUILD-PLAN.md, real liability exposure

Two items `BUSINESS-STRATEGY.md` calls out as promised-but-not-built, both worth prioritizing given they're player-facing trust claims:

- **14-day refund guarantee** — the Market page's trust strip promises this; no refund endpoint exists. Needs: a `Purchase.refundRequestedAt`/`refundedAt` field, a refund request flow (buyer-initiated within 14 days of purchase), a Stripe refund API call, and reversing the seller's earned split if already paid out. Real liability exposure until built — a buyer could reasonably feel misled requesting something the UI promises but the backend can't fulfill.
- **Seller verification badge** — currently cosmetic, no actual identity check behind it. Needs an actual verification step (could be as light as confirming a connected Stripe Connect account is fully onboarded/verified by Stripe itself, which Stripe already tracks — likely the cheapest real signal to hang the badge on, rather than building custom KYC).

## 4. Hosted-VM compile → **decided: build it**, as a paid Priority Compile option

Full engineering detail now in `TOKEN-SYSTEM-BUILD-PLAN.md` Step 5. Summary of the decision: this ships as a **paid alternative alongside the existing free own-GitHub compile**, not a replacement — billed in credits at 2× markup on the per-target cost basis already priced in `BUSINESS-STRATEGY.md` (light ~$0.002/run up to mac-only ~$0.05–0.20/run). Recommended implementation is the lighter option: reuse the existing compile pipeline unchanged, just targeting a Morpheus-owned GitHub org/account instead of the user's own connection, rather than building custom VM orchestration from scratch. This also becomes a genuine third revenue line (direct "priority build" income) beyond credits and marketplace commission.

## 5. Annual billing → **moot.** No subscription exists to offer an annual variant of, now that Pro is gone. Removed from scope entirely rather than just deprioritized.

## 6. Churn/downgrade handling → **moot.** With no subscription tier, there's no downgrade event to handle — a user's balance is just whatever token blocks they've bought minus what they've used, same for every account. What was previously "what happens on downgrade" simplifies to: nothing, because there's no tier to fall out of. Existing projects/templates were never going to be touched either way, so the spirit of the original decision (users keep everything) still holds — it's just no longer a distinct engineering concern.

---

## Consolidated build order (all monetization engineering, one sequence)

Merges this doc's net-new items with `TOKEN-SYSTEM-BUILD-PLAN.md`'s existing 7 steps into one priority order:

1. **Token plan Steps 1–2** (schema + real metering) — foundational for everything else, ships safely alone.
2. **Token plan Step 3** (pre-call reserve + reconcile billing enforcement) — decision closed, build directly.
3. **Marketplace trust features** (item 3) — refund flow and real seller verification. Independent of the token-system work, can be built in parallel.
4. **Token plan Step 6** (frontend cost transparency + token-block purchase flow) — one-off Stripe Checkout, same pattern already built for marketplace purchases. No subscription infrastructure needed at all now.
5. **Token plan Step 5 — Priority Compile** (item 4) — decided go; reuses the existing compile pipeline pointed at a Morpheus-owned GitHub org, billed via the same reserve/reconcile pattern.
6. **Token plan Step 4** (admin pricing controls) — sequenced as the Admin Control Panel's first real feature, whenever that panel gets built.
7. **Token plan Step 7** (final verification pass across metering, enforcement, token-block purchase, and Priority Compile together).

---

**Decisions closed this pass** (were open questions in `BUSINESS-STRATEGY.md`'s final section): pre-call vs. post-call billing → **pre-call**; hosted-VM compile go/no-go → **go, as paid Priority Compile**; pricing model → **no free tier, no Pro subscription, pure pay-as-you-go token blocks on a cheap frontier model by default, plus a guided free path via the user's own Gemini API key**. This also resolved the churn/downgrade, annual-billing, and new-user-cold-start questions by making them moot, and separately **resolves the previously-open Gemini 503 issue** (`BUILD-PLAN-2.0.md` Tier 1) — the congestion was always a symptom of everyone sharing Rob's personal free-tier quota; moving users onto their own keys removes the shared bottleneck entirely. Still genuinely open: exact token-block denominations. The owner-exemption mechanism is effectively resolved too, via the Admin Control Panel discussion — a real role column, not a hardcoded email — just needs building that way in Step 1.

**Bottom line**: the real engineering scope hiding inside "the business strategy" turned out smaller than first scoped, not bigger, once the pricing model simplified — no Stripe Subscriptions, no recurring billing, no downgrade logic. What's left is genuinely lean: token metering + pre-call billing, one-off block purchases (reusing existing Checkout infrastructure), a marketplace refund/verification pass, and Priority Compile as a new paid feature. This doc reflects that leaner scope.
