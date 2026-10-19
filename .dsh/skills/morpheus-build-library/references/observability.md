# Observability: telling "nothing happened" apart from "we could not see"

## A failed read must never render as its empty state

The worst incident of its kind here: `server/src/entities.js` reads with no
`select`, so Prisma asks for every column; a column the database did not have
threw `P2022`; the Workspace had no error handling on that load. It therefore
rendered **"No constructs found. The Matrix is empty."** — indistinguishable from
having lost everything. Rob spent the next while believing his work was gone.

**Rule: "you have none" and "we could not read them" must never look the same.**
A failed load renders as an error *with a retry*. This is the UI half of H11, and
H11 only ever stated the blast radius, not this.

## Logs must distinguish "didn't fire" from "fired and found nothing"

The production line read, every time:

    [deck-insight] 1 account(s): 0 raised, 1 skipped

That looks like the feature never runs. It does not mean that.
`synthesizeDeck()` returning `{skipped: true}` — the model answering "nothing
worth raising", which is the designed behaviour on most days — incremented the
*same counter* as being gated before the model was ever called. Two completely
different outcomes collapsed into one number, and it was read as a broken
feature. Counter or log a *reason*, not just a total.

## Read the container's log, not the app's log reader

`getBackendLogs` reads Cloudflare and Supabase — **not** the Northflank
container. So during the 2026-09-19 outage the crash-loop had to be *inferred*
from an `istio-envoy` 503 plus polling the public health endpoint, when the
container's own log would have said `ERR_MODULE_NOT_FOUND` immediately.

    node scripts/northflank.mjs status
    node scripts/northflank.mjs logs --search "ERR_" --minutes 30
    node scripts/northflank.mjs logs --type build --minutes 60

The credential is a read-only Northflank token (View Services + View
Observability) in `server/.env.northflank`. **Never infer a crash-loop from a
proxy's 503** — that is a symptom of "no healthy upstream", not a cause.

## Cost is a signal too

`scripts/usage [session-id|--all|--json]` reads the harness session projection
cache, so it makes no model calls and bills nothing. The GUI's "{percent} of
context used" renders the same data, but DSH tracks tokens rather than money —
there is no cost display in the UI, so this script is the only local estimate.
Rob is paying the API bill; treat an unexplained cost jump as a bug report.

## What to reach for

| Question | Command |
|---|---|
| is the backend up, and what did it just say? | `node scripts/northflank.mjs status` / `logs` |
| what is actually true (repo + prod + claims)? | `node scripts/reality.mjs` |
| what is the code right now? | `node scripts/context.mjs` |
| why was it built this way? | `node scripts/sessions.mjs "<query>" --reasoning` |
| what is this session costing? | `scripts/usage` |
