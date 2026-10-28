# Credits policy

**Status:** implemented mechanism, commercial values deliberately unset
**Decision owner (commercial):** Rob
**Last written:** 2026-10-27
**Related code:** `server/src/lib/creditPolicy.js` (rules), `server/src/lib/billing.js`
(reserve → reconcile), `server/src/lib/creditExpiry.js`, `server/src/lib/buildBudget.js`
**Guard:** `scripts/verify-credits-policy.mjs` (run by `node scripts/verify.mjs`)

This document states the rules. It does not invent a price, a cap, an expiry window or a
per-build ceiling — those are Rob's commercial decisions and are listed as placeholders at
the end.

---

## 1. What a credit is

A credit is **a unit of Morpheus service**. It is not a quantity of provider tokens, not a
share of a model bill, and not stored money.

The internal mechanics that already exist are unchanged: `User.credit_balance` is a
`Decimal(14,4)`, purchases are recorded in `CreditTransaction`, and the AI call path
reserves before a call and reconciles against real usage afterwards
(`reserveCredits` → `reconcileCredits`). This policy wraps those mechanics; it does not
replace them.

## 2. The face rate

The decided face rate is **$0.005 per credit** — $5 per 1,000 credits — for **new
purchases**. It is the single published conversion; `CREDIT_RATE_USD` in
`server/src/lib/creditPolicy.js` is the one place it is written down, and
`server/src/lib/billing.js` re-exports it so existing importers keep working.

Changing the face rate is a commercial decision. It is not made by editing a block price,
a markup, or this document alone.

## 3. Repricing happens on two levers only

1. **The face rate** — what a *new* purchase buys. A higher face rate means more dollars
   per credit, or fewer credits per dollar; either way it applies to new purchases.
2. **`markup`** — the multiplier applied to provider cost for *all consumption*
   (`ModelCatalogEntry.markup_multiplier`, default `2.0`; see `resolveBillingMarkup`).

Both levers are forward-looking. **No repricing is ever applied retroactively to an
existing balance.** Credits already bought stay at the value they were bought at; a later
face-rate or markup change does not rewrite them.

## 4. The published conversion is ours to revise, with notice

Morpheus may revise the published conversion (the face rate and/or the markup) for future
purchases and future consumption. The terms must say so, and a change is announced before
it takes effect. Existing balances are not rewritten by it (see §3).

## 5. "Own it for life" means the software, never the credits

The ownership promise is about the **software Morpheus produces for you** — the source
code, files and builds you can download, keep and deploy. It does **not** describe credits,
a balance, a stored-value account, or a right to future AI calls. No customer-facing copy
may blur those two things.

## 6. Balance cap (mechanism; value unset)

A customer balance may be capped. The cap is enforced **at purchase**: if a purchase would
take the balance above the cap, `createTokenCheckout` refuses to create the Stripe session
with `409` / `CREDIT_BALANCE_CAP`. The customer is not charged.

- Configuration: `CREDITS_BALANCE_CAP` (credits).
- Unset, empty, `0`, negative or unreadable = **no cap** — the mechanism is off.
- A paid purchase that races an existing checkout is honoured rather than confiscated; the
  checkout gate is the enforcement point the customer sees. Credits already paid for are
  never deleted to satisfy a cap.

**Placeholder value:** not set. Rob decides.

## 7. Balance expiry (mechanism; window unset)

Purchased credits may expire. **Signup grants never expire.** The signup grant is the
`User.credit_balance` default (200 credits) and is deliberately not represented as a
purchasable lot.

- Configuration: `CREDITS_EXPIRY_MONTHS` (whole months from the purchase date).
- Unset, empty, `0`, negative or unreadable = **no expiry** — the mechanism is off.
- Consumption is allocated to purchases oldest-first, so an expiry removes only the
  *unused* part of a purchased lot. Signup credits sit behind purchases and are exempt.
- An expiry is written as a `CreditTransaction` with `status: 'expired'` and a negative
  `credits` value, then applied to the balance in the same transaction. That row is what
  makes the operation idempotent and what `scripts/verify-billing-ledger.mjs` reads.
- Expiry is applied lazily, before a reservation and before a purchase (and before the
  webhook grant). A dormant account is not swept by a background job yet; when Rob sets a
  window, the same helper can be called from a scheduler without changing the rule.
- No schema change is required: expiry is derived from `CreditTransaction.created_date`,
  and an expiry is recorded as a `status: 'expired'` row in the existing ledger.

**Placeholder value:** not set. Rob decides.

## 8. Per-build spend ceiling (mechanism; N unset)

An unattended build cannot exceed **N credits** without explicit consent.

- Configuration: `CREDITS_BUILD_CEILING` (credits per build).
- Unset, empty, `0`, negative or unreadable = **no ceiling** — the mechanism is off.
- The ceiling is keyed by **project id**. A build's budget is stored in `PlatformSetting`
  under `build_budget_<projectId>` and reservations are counted against it in the AI
  reservation path (`reserveCredits`), not in the build loop. The build loop's planning,
  coding, reviewing and file application are unchanged.
- Explicit consent is a per-project `PlatformSetting`:
  `build_ceiling_consent_<projectId>` — a number of additional credits allowed for that
  project. Setting it is an explicit, auditable action; it is not inferred.
- The reservation that would cross the ceiling throws `BUILD_CEILING_EXCEEDED` (HTTP 402)
  before any AI call is made. The next call is blocked until consent is granted.
- A `chatWithMorpheus` build starts a fresh budget; an `autonomousBuildStep` continues the
  project's current budget and clears it when the step reports `isComplete`.

**Placeholder value:** not set. Rob decides.

## 9. Reporting

`node scripts/credits-report.mjs` reports, from production:

- credits **sold** (paid `CreditTransaction` rows) and the dollars collected;
- credits **consumed** (`UsageEvent.credits_charged`);
- credits **expired**;
- **outstanding liability** — current balances in credits and dollars at the face rate;
- **float as a share of the monthly provider bill** — outstanding liability dollars divided
  by the trailing-30-day `UsageEvent.cost_usd`.

The report is read-only. Exit 2 means the production credential is missing — not verified,
never a pass.

## 10. Enforcement

`scripts/verify-credits-policy.mjs` asserts:

- the face rate in code matches this document;
- the cap, expiry and per-build-ceiling configuration exists and off means off;
- the cap is checked in the purchase path;
- expiry is wired into the reservation and purchase paths, and signup credits are not a
  purchasable lot;
- the ceiling is reached through the reservation path with a project id;
- no customer-facing copy promises a free AI path or "no expiry";
- the terms carry the credit-is-service and ownership-is-output clauses;
- the deferred-revenue report still reports sold vs consumed vs outstanding vs provider
  bill.

The guard is registered in `scripts/verify.mjs`, `scripts/guards-list.json` (CI) and
`scripts/guard-mutations.mjs` (a proof that it can fail).

---

## 11. Draft terms wording (Rob to approve)

This is wording for the public terms page, not legal advice. It is deliberately short: a
credit is a service unit, and ownership is the output.

> **Credits are service units.** A credit is a unit of Morpheus service. It is not a
> quantity of provider tokens, not a share of a model bill and not stored money. We may
> revise the published conversion for future purchases and future consumption with
> notice; a change is never applied retroactively to an existing balance. Purchased
> credits may expire after the period shown at purchase; signup credits are exempt from
> expiry. Balances may be capped, and an unattended build may pause at a per-build spend
> ceiling until you give explicit consent.
>
> **Ownership is about output, not credits.** "Own it for life" refers to the software
> Morpheus produces for you — the source code, files and builds you can download, keep
> and deploy. It does not refer to credits, a balance, or a right to future AI calls.

The same two paragraphs are drafted into `src/pages/Terms.jsx`; `verify-credits-policy.mjs`
asserts both carry the two clauses.

## Decisions Rob must make

| Decision | Config | Current |
|---|---|---|
| Face rate | `CREDIT_RATE_USD` (decided, $0.005) | $0.005 — no change needed |
| Balance cap | `CREDITS_BALANCE_CAP` | unset (mechanism off) |
| Purchased-credit expiry window | `CREDITS_EXPIRY_MONTHS` | unset (mechanism off) |
| Per-build ceiling | `CREDITS_BUILD_CEILING` | unset (mechanism off) |
