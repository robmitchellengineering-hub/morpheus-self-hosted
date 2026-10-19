# Third-party connections: OAuth, GitHub accounts, and credentials

Everything here is a browser-redirect flow where the failure is silent: no
error surfaces, the feature simply never has data.

## An OAuth callback is a top-level navigation, not an API call

It must **never** sit behind `requireAuth`. The browser arrives from Google with
no Bearer token, so the guard answers first and the user sees raw
`{"error":"Unauthorized"}` instead of landing back on Settings — caught live on
2026-09-16. Recover identity from the signed `state` parameter instead, and keep
the callback route outside the authenticated group (the same shape as `/start`
and `/connect`).

## Request the scope that returns the data you persist

The Drive flow requested only `drive.file`, so Google's userinfo endpoint
returned **no email field** — and the upsert wrote that field, so it threw every
time and no `GoogleDriveConnection` row was ever created. Nothing logged an
error the user could see; the connection just never appeared. **If you store an
email, request a scope that returns one** (`drive.file email`, or `userinfo.email`).

## Do not infer a GitHub account from an email or a search

GitHub's user search is a *fuzzy search over public profile text*, not an account
lookup: one probe address returned 13 loose matches, and most people keep their
email private. Ask the person for their username, or use the account the OAuth
connection already authenticated as — never guess and then operate on the guess.

## Prove a credential before you store it

A `/status` field saying `signing: true` only proves *a* secret is set, not that
it is ours. The cheap proof that works on every version is a signed call with a
deliberately invalid payload: a verified signature answers `400 bad_request`
(the payload is rejected *after* the signature is checked) while a wrong secret
answers `401`. Nothing is written. See `wordpress.md` for the WordPress form of
this, and note the same principle applies to any connection whose stored
credential you did not personally create.

## Scopes are part of the product surface

A scoped token's scope map is a security boundary, so **a destructive or
repo-creating function must not be in a widget's scope**. The website widget
deliberately includes `getWordPressStore`, `wordPressSeoAction`,
`generateSeoMeta`, `generateBlogPost`, `suggestInternalLinks` and
`researchKeywords`, and deliberately excludes `createSiteWorkingCopy` — the
first six read or propose, the last one writes to a repository.

## Secrets have exactly one correct place

Never paste a secret into chat. Session logs are plaintext JSONL under
`~/.dsh/sessions/` and the text is transmitted to the model provider, so a
credential pasted "just to test it" is a credential disclosed twice. Put it in
the gitignored env file it belongs in (`server/.env`, `.env.prodsql`,
`.env.northflank`) and read it from there. If a credential has already been
pasted, rotate it — that is the only fix, and it is why the Northflank owner
token is on the list to narrow.

## Reuse the connection that already exists — and respect what its scope allows

Before building anything that talks to a third party, look for a connection that
already does. The Alice Stats photo widget needed "upload to the user's Drive"
and found `googleDriveConnection` (`lib/googleDrive.js`) already there: per-user,
encrypted tokens, silent refresh, scope `drive.file`. Standing up a second OAuth
client would have meant a second consent screen for the same account.

**A scope is a promise about what the feature can do, so read it before promising
anything.** `drive.file` grants access only to files **this app created** — not
"the user's Drive". So:

- a folder the app creates is always writable, which is why the widget offers to
  create one (`Morpheus Photos`) rather than starting from a folder picker;
- a folder the user pastes from their own Drive may legitimately come back **403**,
  and that is not a bug, a missing folder, or something to retry;
- **403 and 404 must never be reported as the same failure** — one means "this
  connection cannot write there", the other "no such folder", and the operator's
  next action is different. `classifyDriveError()` in `lib/photoDrive.js` exists
  for exactly that, and `verify-photo-drive.mjs` asserts the two messages differ.

Two more rules this feature had to obey, both general:

- **Binary content must never pass through string concatenation.** `createDriveFile`
  used to build its multipart body with `+`, which silently re-encodes every
  non-UTF8 byte — Drive stores whatever it is given, so a corrupt photo uploads
  "successfully". It now takes a Buffer and the text path is unchanged.
- **Prefer an existing JSON column to a new column.** The chosen folder id lives in
  `UserSettings.connections` under a namespaced key, because migrations here are
  hand-run SQL (H8) and a folder preference does not justify one.

## One user, one Google consent

Rob, 2026-09-22, after a photo widget shipped asking for Google twice: *"The google
credentials should come from the google connected from the user."*

There are **two** per-user Google connections here — `deckGoogleConnection`
(Gmail, Calendar, Docs, `drive.file`, email) and `googleDriveConnection`
(`drive.file email`) — and both can write to Drive. A feature that needs a Google
token must resolve it from **whichever the user already granted**, and only prompt
when they have neither. Asking someone who already connected Google for the Deck to
connect it again for one widget is the wrong default, and it is the kind of thing
nobody notices while building the feature in isolation.

- Look for an existing resolver before adding a flow. `getDeckGoogleConnection`
  and `getGoogleDriveConnection` both return `{ email, token }` or null and handle
  refresh; `getGoogleDriveToken` is the odd one out because it **throws** when its
  connection is missing — using it silently makes that one connection mandatory.
- **Prefer the broader connection first** and encode the order as data
  (`GOOGLE_SOURCES`), not as an if-chain, so a guard can assert it and the order
  cannot drift.
- **Say which account will be used.** Both rows carry the email; showing it is how
  a user knows where their data is going without re-consenting to find out.
- Pin the bug, not just the fix: assert that **neither** connection is a hard
  dependency, and that a user with only one of them is served. The failure mode to
  guard against is a future "simplification" back to the single connection the
  author happened to know about.

Same rule for any future Google feature — Drive, Gmail, Calendar or a new one.
