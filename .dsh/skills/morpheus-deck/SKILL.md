---
name: morpheus-deck
description: "Command Deck / Jarvis domain rules — the own-data-architecture rule, self-serve additive migrations against Supabase, and Jarvis's persona. Rules only; the feature inventory is generated. Load before touching anything under /deck."
whenToUse: "Load before changing any Command Deck or Jarvis code — new widgets, connections, memory/history mechanisms, database migrations, or the /deck surface itself."
---

# Command Deck / Jarvis

Ported from Rob's Claude Code project memory (last modified 2026-09-17).

## What it is

A customizable "life-assist" dashboard at **`/deck`** inside this repo, powered
by an AI persona called **Jarvis** — distinct from **Morpheus**, which stays the
app-building agent. Cross-domain synthesis (business + health + money +
relationships + growth) is the entire point; it is not a Valiant-Music-specific
hardcoded build, and everything shipped so far is Rob's own first working
example of it.

`/deck` is **no longer admin-gated** — it sits in the ordinary authenticated
route group (`App.jsx:164`, outside the `adminOnly` group at `App.jsx:171`).
The data layer was already multi-tenant (every `Deck*` entity is scoped by
`created_by_id` through the generic entity engine), so the route guard was the
last real gate. Each account sees only its own Deck.

An earlier revision of this file said `/deck` was still admin-gated. That was
true when the source memory was written (2026-09-17) and had already changed by
the time it was committed here.

## How the Deck is fed: dictation → auto-file → synthesis

**This is the product, and getting it backwards leads to building the wrong
thing.** Rob stated it plainly:

> "brain dump automatically files stuff to those places through dictation it
> will asign tasks to people etc and all those streams are just so javis can
> help peice all the life context together and give the best sythisis of the
> data for holistic life sucsess"

So the loop is: **Rob speaks freely → Jarvis files each thought where it belongs
→ Jarvis synthesises across all of it.** The five life streams
(health/money/home/people/growth) are **destinations his own words are filed
into**, not integrations to be connected.

**Do not build an OAuth/API connector for a life stream.** There is no banking
sync, no health-app sync, no "connect the things you already use" plumbing to
add — a stream fills up because Rob talks and the dump files it there. The
own-data rule below governs connectors that genuinely exist (e.g.
`DeckGoogleConnection`); it is **not** a mandate to create one per stream. This
was misread once already, and the near-miss was a proposed banking integration
that the user had never asked for.

**Everything that threatens capture is a whole-product threat.** Synthesis can
only reason over what actually got filed, so a dump that loses, merges or
misfiles a thought doesn't degrade one feature — it starves the synthesis that
is the entire point. Concretely:

- A dump is usually **several thoughts in one breath** (dictation on a phone is
  the primary input). It must be split and each piece filed separately, with its
  own destination **and its own owner**. `lib/deckDumpClassify.js` owns this and
  `scripts/verify-dump-classify.mjs` asserts it.
- **Nothing may be silently dropped.** If classification is uncertain, the
  original text is filed whole rather than summarised — the user's words are the
  valuable part, the bucket is recoverable.
- A name in the text must never drag the *whole* dump onto that one person.

## The own-data rule (standing architectural rule)

Every Deck/Jarvis integration gets its **own data, own connections, own
accounts** — deliberately never shared with Morpheus's own equivalent.
`DeckGoogleConnection` is separate from `GoogleDriveConnection` and login's
Google OAuth; `DeckJarvisMessage`/`DeckJarvisMemory` are separate from
`ChatMessage`. Private and separate by default, **not reused for convenience**,
even when that means near-duplicate OAuth plumbing.

Built to the **same rigor as Morpheus itself** — same PR-per-phase discipline,
same verify-before-ship bar. Not a lower bar because it's "just a personal
feature."

**Check every new Deck/Jarvis feature against this, specifically:**

- **Does it cap or window data that's cheap to keep in full?** Don't. Keep full
  history unless there's a real cost/scale reason — and if a cap is genuinely
  needed, say so explicitly.
- **Does it reuse a Morpheus-level connection or account for convenience?** Don't.
  Give it its own.
- **Does a "memory" or "history" mechanism actually persist**, or does it just
  carry the current session / recent window? If Jarvis should remember it later,
  it needs a real persistence path — Postgres plus the Drive mirror pattern
  already established in `lib/deckMemory.js` — not just an in-context window.

**Why this rule exists:** Rob stated it after catching two real violations —
Jarvis's energy log was silently capped at 14 days (inherited verbatim from the
prototype, never questioned) and its "memory" was a 12-turn rolling window with
nothing persisted before that. Both were fixed, and he then stated the general
rule rather than catching each instance one at a time.

## Migrations: run them yourself

Command Deck's additive SQL lives at **`server/prisma/add-deck-*.sql`**. The
database is **Supabase**, and Rob's explicit instruction is to run these
directly rather than leaving them typed-and-waiting for him:

> "I wish you would, it would make my life easier."

**Scope — this applies only to additive/idempotent SQL:**
`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, safe
`UPDATE ... WHERE` backfills. These are safe to re-run.

**It does NOT extend to destructive or ambiguous SQL** — drops, data-loss
operations, anything outside that pattern. Those still get checked with Rob first.

**The failure this prevents:** four migrations from one session were left
typed-and-waiting and never actually ran — Command Deck's main data load was
silently broken in production (`deck_people.email does not exist`) until it was
caught from a live console error.

### Browser-typing gotcha

When typing SQL into the Supabase editor via browser automation: **avoid inline
`--` comments.** The editor's autocomplete widget corrupted a comment mid-type
once (inserted `pgp_sym_encrypt` into comment text), throwing a syntax error
before anything executed. Plain statements with no comments have typed cleanly
every time. **Screenshot after typing, before running**, to catch corruption.

### Standing check after any schema change

Verify in production that the migration actually landed — an
`information_schema` read query, or reload the live app and check the console.
**A migration file sitting in the repo does not mean it was applied.**

## What exists — do not enumerate it here

The feature inventory is **generated**, not remembered:

    node scripts/context.mjs

That reports the current Deck/Jarvis function files, `Deck*` models, `/deck`
pages, widget count, and whether the synthesis card, vault check and long-term
memory are present — all read from the code.

This file used to carry a hand-written list headed *"Shipped (as of 2026-09-17)"*.
By 2026-09-19 it was already wrong: it listed the data-vault check and the Jarvis
synthesis card as unbuilt when both had shipped. That is what a status snapshot
in a curated document always does — it is accurate for a day and then quietly
misleads. Facts belong in a generator; this file keeps the rules.

What is **not** derivable from code, and is therefore kept here:

- **Jarvis's persona is a product decision, not an accident of the code.** Butler
  plus big brother, dry cutting wit, cross-domain expert-career framing,
  holistic-life worldview. He is deliberately *not* a generic business advisor,
  and replies match the question's length rather than producing a report.
- **The Jarvis ↔ Morpheus inter-agent vision is genuinely unstarted.** That is a
  scoping decision, not a status line — see `morpheus-vision`.

## Reference for feature parity

`https://valiant-command-deck.pages.dev/` — the original, more-evolved prototype
this was ported from feature-by-feature. Worth re-checking when unsure whether
something was missed; it has already caught two real gaps (Tone/Spectrum tools,
and the energy-log/memory windowing issue).
