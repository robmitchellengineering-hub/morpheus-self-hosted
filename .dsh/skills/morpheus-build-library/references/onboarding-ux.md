# Onboarding, wizards and first-run paths

## Ask the system, then ask the person
The connect wizard's step is decided by probing the site, not by what the operator
says about it: `install` (WordPress answered, plugin did not), `update` (too old,
and whether it can update itself), `behind_login`, `pair`, `unreachable`. Each
untested guess about their situation is a dead end with a link they cannot use.

## "Ensure" belongs on the server, named for what it guarantees
`ensureWebsiteConstruct` opens the account's existing website construct or makes
one — a *function*, not a button that creates a project, because "open a
construct" has to mean the same one every time. A client that creates one per
visit leaves a trail of empty constructs and a phone double-tap races itself.
Idempotency is a property to test: first call creates, later calls reuse, even
with different arguments.

## Preserve intent through every redirect
A generic auth guard that redirects to a bare `/login` loses where the person was
going. Routes that carry intent (`/start`, `/connect`) sit outside that guard,
check auth themselves and redirect to `/login?returnTo=<the same page>`. Also:
never navigate to a sign-in page from a sign-in page — that is an infinite
reload loop, and it is what an expired token used to do.

## One thing at a time, with the state visible
Every step says what it is for, what will happen, and what the system currently
believes. Numbers like "4 to go" come from live state, not a fixed list, and a
finished row loses its button rather than inviting a second press.

## Be honest about the platform limit
WordPress will not let anything install a plugin without an administrator, and
Morpheus will never ask for a WordPress password. So the panel says that, and
gives every route the person actually has: the guided upload, the WP-CLI line for
anyone with a terminal, and a ready-to-send message for whoever manages the site.

## No dead ends
Every audit finding appears on the item it belongs to; every proposal has a
reason when it is rejected; every list row goes somewhere. If a control cannot
act, it is disabled *and* the screen says why — a disabled button with no
explanation is a dead end wearing a different hat.
