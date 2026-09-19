---
name: morpheus-deck
description: "Command Deck / Jarvis domain rules — the own-data-architecture rule, self-serve additive migrations against Supabase, and what's shipped vs outstanding. Load before touching anything under /deck."
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

`/deck` is currently **admin-only-gated** in `App.jsx` (in the `adminOnly`
`ProtectedRoute` group). Revisit once it's ready to be per-user customizable.

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

## Shipped (as of 2026-09-17)

- Nav restructure: bottom tab bar (Deck/Jarvis/Tools/Settings); separate
  installable PWA at `/deck` with its own manifest and icon.
- Jarvis: real persona (butler + big brother, dry cutting wit, cross-domain
  expert-career framing), grounded in a live Deck data snapshot, perpetual
  energy log (no day cap), real long-term memory (`lib/deckMemory.js` —
  condenses conversation as it ages past the recent window, mirrored to the
  user's own Drive as `jarvis-memory.md`).
- Workshop Tools: tuner, unit converters, electronics calculators, tone
  generator, spectrum analyser — parity with the reference prototype.
- Google integration: `DeckGoogleConnection` (Gmail + Calendar + Drive + Docs),
  Gmail sync with two-layer AI inquiry classification, AI-suggested replies,
  Drive backup/restore (wipe-and-replace, behind explicit confirm).
- Brain dump auto-files (`classifyDeckDumpItem.js`): task / strategy / knowledge /
  life-stream, classified by actionable-vs-reflection ("get milk" files as a task).
- Calendar ↔ Murbah two-way sync (`booking_date`/`calendar_event_id` on
  `DeckMurbahOpportunity`).
- Jarvis-driven Google Doc creation (`createDeckDocument.js`).
- Editable "me" person (`is_self` flag, decoupled from the literal name "You");
  people have an email field; tasks can be texted or emailed to owners.
- Collapsible sections, searchable lists, file attachments (photo vision +
  PDF/DOCX/XLSX server-side extraction; only a filename reference is persisted).
- Admin-gated `/deck` with usage meter and buy-credits (Deck shares one credit
  pool with Morpheus).

## Not yet built

- Data-vault reachability status beyond the last-backup timestamp.
- The one-shot Jarvis "connect the dots / Get suggestions" synthesis card.
- The Jarvis↔Morpheus inter-agent vision — see `morpheus-vision`.

## Reference for feature parity

`https://valiant-command-deck.pages.dev/` — the original, more-evolved prototype
this was ported from feature-by-feature. Worth re-checking when unsure whether
something was missed; it has already caught two real gaps (Tone/Spectrum tools,
and the energy-log/memory windowing issue).
