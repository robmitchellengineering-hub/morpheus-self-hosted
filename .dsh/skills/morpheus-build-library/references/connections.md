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
