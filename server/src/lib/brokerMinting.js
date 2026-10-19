// Which account a call to /api/broker/* may act for, and whether it may act at all.
//
// WHY THIS IS SEPARATE AND IMPORT-FREE. The broker endpoints have two audiences — the broker itself,
// authenticated by a shared secret, and an install's own server, which needs a gateway token for the
// account it is running a request for — and getting the distinction wrong is the difference between
// "the operator's own install can mint its own token" and "anyone who can reach this URL can mint a
// token for anybody". That is worth asserting as BEHAVIOUR in CI's no-install job rather than leaving
// as a conditional buried in a route handler, which is what `scripts/verify-broker-minting.mjs` does.
//
// The rule is deliberately narrow: an internal-secret caller may name an account, a session caller
// may only be itself, and a caller with neither gets nothing.

/**
 * @param {{ internalSecretMatches?: boolean, sessionUserId?: string|null, requestedAccountId?: string }} args
 * @returns {{ ok: true, accountId: string, via: 'broker'|'session' } | { ok: false, status: number, error: string }}
 */
export function resolveTokenMint({ internalSecretMatches = false, sessionUserId = null, requestedAccountId = null }) {
  const session = sessionUserId ? String(sessionUserId) : '';
  const requested = requestedAccountId ? String(requestedAccountId) : '';

  // A session may only ever mint for itself — and a session that names a DIFFERENT account is refused
  // rather than quietly redirected to its own, because silently answering a different question than
  // the one asked is how a caller ends up believing it holds a token for someone else.
  if (session) {
    if (requested && requested !== session) {
      return { ok: false, status: 403, error: 'a signed-in account can only mint a gateway token for itself' };
    }
    return { ok: true, accountId: session, via: 'session' };
  }

  // No session: only the broker secret, and only with an account named. This is the path an
  // install's own server uses when it mints a token on behalf of the account it is serving.
  if (internalSecretMatches) {
    if (!requested) return { ok: false, status: 400, error: 'an internal caller must name an accountId' };
    return { ok: true, accountId: requested, via: 'broker' };
  }

  return { ok: false, status: 401, error: 'authentication required' };
}

/** The mint's response body, so the route and the installer cannot disagree about its shape. */
export function mintResponse({ token, expiresAt, provider }) {
  return { token, expiresAt, provider };
}
