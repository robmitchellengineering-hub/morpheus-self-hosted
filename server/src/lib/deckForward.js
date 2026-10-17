// Forward-to-Jarvis capture: the pure matching logic that decides whether an
// inbox message was addressed to one of the forward aliases on the connected
// mailbox, and which tag it therefore carries.
//
// WHY THIS IS ITS OWN MODULE
//
// `scripts/verify-deck-forward.mjs` has to prove this matcher actually detects
// a forward — the H13 concern (a silently-empty result read as "no forwards
// ever arrived") in miniature. Importing `syncDeckGmailInbox.js` would drag in
// Prisma and the AI gateway, so the guard could not run in CI's no-install
// guards job. Same reason `deckSnapshotText.js` / `promptBounds.js` are
// import-free: a guard that cannot run is not a pass.
//
// Import-free on purpose: no Prisma, no fetch, no env. Pure data in, data out.

// The two consumers a forward can be aimed at. "jarvis" is the account's own
// Deck assistant; "build" is the developer agent building the account's stuff.
// They share one mailbox, so the address suffix is what tells them apart.
export const FORWARD_TAGS = ['jarvis', 'build'];

/**
 * Which forward tag a message was addressed to, or null when it was not sent to
 * a forward alias at all.
 *
 * @param {string} googleEmail The connected mailbox, e.g. "info@valiantmusic.com.au".
 * @param {...(string|undefined)} headerValues To / Delivered-To header values to search.
 * @returns {'jarvis'|'build'|null}
 */
export function forwardTagFor(googleEmail, ...headerValues) {
  if (!googleEmail) return null;
  const at = googleEmail.lastIndexOf('@');
  if (at <= 0 || at === googleEmail.length - 1) return null;
  const local = googleEmail.slice(0, at);
  const domain = googleEmail.slice(at + 1);

  // One haystack from every header value we were handed; a forward can be
  // matched by either To or Delivered-To, and there may be several recipients.
  const haystack = headerValues.filter((v) => typeof v === 'string' && v).join(' ').toLowerCase();

  for (const tag of FORWARD_TAGS) {
    if (haystack.includes(`${local}+${tag}@${domain}`.toLowerCase())) return tag;
  }
  return null;
}

/** The forward aliases for a connected mailbox, for docs / status output. */
export function forwardAddresses(googleEmail) {
  if (!googleEmail) return [];
  const at = googleEmail.lastIndexOf('@');
  if (at <= 0 || at === googleEmail.length - 1) return [];
  const local = googleEmail.slice(0, at);
  const domain = googleEmail.slice(at + 1);
  return FORWARD_TAGS.map((tag) => `${local}+${tag}@${domain}`);
}
