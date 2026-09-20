# Checking what is true — claims, documents and production

## The split, and why it exists

Three kinds of knowledge, three different homes. Mixing them is what cost this
project its memory eight times in one day:

| Kind | Home | Why there |
|---|---|---|
| **rules and judgement** | a skill or card | curation preserves rules well |
| **facts** | `node scripts/context.mjs` | derived from the code, so never stale by construction |
| **claims about reality** | `node scripts/reality.mjs` | checked against the live system, not remembered |

`reality.mjs` is the one that answers "is this actually true right now": intent
(curated, the thing everything is measured against), what is built (from
`context.mjs`), live production counts (queried), deploy state (Northflank API),
the token/billing steps, and **each marketing claim checked against the system it
describes**. `--json` for machine use.

It degrades honestly. Without `server/.env.prodsql` the production section prints
`NOT VERIFIED` and the checks that need it are skipped — never guessed. That is
the pattern to copy: a missing credential is exit 2, "not verified", and never a
pass.

## If it disagrees with a document, the document is wrong

That is the whole point of it, and it has earned the rule. Checking 13 planning
documents against the system found ~27 financial contradictions, 12 backlog
contradictions, and claims the live system did not meet:

- **"Yes — 6 platforms"** — `server/src/lib/compile-targets/` holds **ten**
  adapters. The document under-counted the product's best differentiator by four.
- **"No free tier exists"** — five accounts held exactly the 200-credit signup
  grant, and the same corpus elsewhere promised it in plain language.
- **"Your data stays yours, not stored on Morpheus's servers"** — Command Deck
  data lived in 21 `deck_*` tables in Morpheus's own Supabase. A privacy claim
  that anyone who reads the stack can check.
- **"Hard stop before overspend"** — an account sat at **−3.7712** credits. That
  one was fixed in the *product*, not the wording: the true-up now takes only
  what the account holds, and `verify-billing-clamp.mjs` asserts the invariant
  with a 41,205-case sweep.

The archive of that work is `docs/audits/` — evidence of what was found on a day,
not a description of the system. Re-check before acting on any of it.

## Check a punch-list item before you act on it

A backlog item read "**URGENT — Stripe not configured, marketplace purchases have
likely never worked at all**". It was wrong. Production held a real
`cs_live_…` checkout session with `status: paid`, and the donate widget worked.
The cost of not checking was a session spent on a problem that did not exist —
the same failure mode as fixing the wrong bug, wearing a priority label.

## Seeing what the system is doing

- **Now** — `node scripts/northflank.mjs status` and
  `logs --search "ERR_" --minutes 30`. See `observability.md` for why the
  container's own log is the one that matters.
- **Facts** — `node scripts/context.mjs`.
- **Why we did it this way** — `node scripts/sessions.mjs "<query>" --reasoning`.
  Docs record conclusions; session logs record what was tried and ruled out.
- **Production data, read-only** — `server/.env.prodsql` holds
  `PROD_DATABASE_URL`; load it into an ad-hoc query. Never write to production
  from here. The migration runner refuses `UPDATE` unless given an explicit
  `--data-repair`, and in that mode it still requires a `WHERE` clause — the
  requirement is what makes "which rows?" readable rather than accidental.
