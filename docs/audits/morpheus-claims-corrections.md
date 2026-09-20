# Morpheus — claims that need correcting

Checked against the live system on 2026-09-19 (`node scripts/reality.mjs` regenerates this).
Three claims are false, one *undersells*, and one was false for a fixable reason — that one is now true.

---

## 1. "Hard stop before overspend" — ✅ NOW TRUE, no wording change needed

**Claim** (Competitive Positioning v6): billing reserves the estimated cost before the call runs, so a user is blocked *before* overspending, never after.

**It was false.** The pre-call reservation checks the balance, but the post-call true-up added a negative difference unconditionally. A call whose real cost exceeded its reservation could push an account below zero. Production had a real account at **−3.7712 credits**.

**Fixed in the product, not the words** — `reconcileCredits` now takes only what the account actually holds and absorbs any remainder as platform cost (logged, `[billing] absorbed …`). Asserted by `scripts/verify-billing-clamp.mjs`: a 41,205-case sweep proves the balance can never go below zero, and the invariant was verified against a real database.

**Action for you:** none. The claim is now accurate. The only thing outstanding is the one existing account sitting at −3.77 — a one-row repair, blocked on your approval because the migration runner deliberately refuses `UPDATE`.

---

## 2. "Your data stays yours, not stored on Morpheus's servers" — ❌ FALSE, needs rewording

**Claim** (Command Deck explainer): *"Sign in with Google … your data stays yours, not stored on Morpheus's servers."*

**Reality:** Command Deck data lives in **21 `deck_*` tables in Morpheus's own Supabase** — notes, tasks, people, messages, energy logs, focus entries. It is stored on Morpheus's servers, in full. The Drive mirror exists, but it *mirrors*; it isn't the home.

This is the claim I'd fix first. It's a privacy statement, it's checkable by anyone who reads your stack, and being wrong about where personal data lives is the kind of thing that doesn't stay a small problem.

**Suggested wording** (true today, still sells the point):

> "Sign in with Google — and your Deck is mirrored to a backup folder in your own Drive, so you always hold a copy you can walk away with."

Or, if you'd rather not promise it at all:

> "Sign in with Google. Your data is yours to export and back up to your own Drive at any time."

**What would make the original claim true:** the user-choice storage architecture (backlog #12/#53), where project and Deck data live in the user's storage and Morpheus keeps only a summary plus a pointer. That's decided in direction, not built — so the wording should follow the architecture, not lead it.

---

## 3. "No free tier / no free tier exists" — ❌ FALSE, and it contradicts your own explainer

**Claim** (Business Report v6, Competitive Positioning v6): *"The finalized model has no free tier and no subscription"* / *"Moot — no free tier exists."*

**Reality:** the 200-credit signup grant **is live and implemented** — **5 accounts hold exactly 200 credits**, `createTokenCheckout` recoups it on first purchase (`FIRST_PURCHASE_RECOUP_USD = 1.00`), and your own explainers promise it in plain language: *"You start with 200 free credits immediately."*

So the documents contradict each other, and the ones denying the free tier are the wrong ones.

Note this also matters commercially: "$0 to start, 200 free credits" is a **stronger** opening than "no free tier" — the current wording gives away your best onboarding asset and replaces it with a line that sounds hostile to new users.

**Suggested wording:**

> "No subscription, ever. Every account starts with 200 free credits — enough to plan, build and compile a real first app — and then it's pay-as-you-go, or genuinely free forever on your own Gemini key."

---

## 4. "Yes — 6 platforms" — ⚠️ UNDERSTATED, you're selling yourself short

**Claim** (Morpheus Explainer v4): *"Native app? Yes — 6 platforms."*

**Reality:** `server/src/lib/compile-targets/` contains **10 target adapters**: web-app, android-apk, ios-app, mac-app, windows-exe, linux-binary, linux-distro, rpi-distro, arduino-firmware, python-package.

**Suggested wording:** say **ten**, and name them. Breadth of native output is one of your genuinely defensible differentiators against every competitor in the comparison table — and right now the document under-counts it by four.

---

## The one decision underneath all of this

The documents disagree about whether a free tier exists because **the decision was never made in one place** — it exists in the code, in the explainers, and in the financial reports in three different states. Pick one and make the others reference it:

- 200 credits at signup, recouped on first purchase — **this is what the code does**, and what the explainers promise.
- Then fix Business Report v6 and Competitive Positioning v6 to match.

---

## Not claims problems (so you don't chase them)

- `CostTracker.jsx`'s "FREE TIER" labels are about **external services** (Northflank, Supabase, GitHub free tiers) — accurate, unrelated.
- No competitor comparison table or explainer copy exists anywhere in the app's code. All of this is document-only, which is why it could drift this far without anyone noticing.
