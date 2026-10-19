// CORS origin resolution.
//
// Extracted from index.js so the decision is a pure function and can be tested
// directly — the previous version was inline and defaulted to `*`, which
// combined with `credentials: true` told every browser it was fine to send
// credentials from any origin.
//
// Auth here is a Bearer token (src/api/base44Client.js reads it from
// localStorage and sets an Authorization header); nothing on the server ever
// SETS a cookie — `req.cookies.morpheus_token` in auth.js reads one that no
// code writes. So credentialed CORS is not needed at all, and it is pure
// liability: it invites browsers to attach credentials to cross-origin requests
// from any site.

/** Used when CORS_ORIGIN is unset — the local dev frontend, matching .env.example. */
export const DEFAULT_CORS_ORIGIN = 'http://localhost:5173'

/**
 * Resolve CORS_ORIGIN into what the cors middleware needs.
 *
 * @param {string|undefined|null} rawValue  the CORS_ORIGIN env value
 * @returns {{origins: string[], wildcard: boolean, origin: true|string[], credentials: boolean}}
 */
export function resolveCors(rawValue) {
  const parsed = String(rawValue ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Default to the dev frontend rather than '*'. If a deployment forgets to set
  // CORS_ORIGIN it should fail CLOSED (the real frontend is refused, loudly and
  // immediately) rather than fail OPEN (every origin is accepted).
  const origins = parsed.length > 0 ? parsed : [DEFAULT_CORS_ORIGIN]
  const wildcard = origins.includes('*')

  return {
    origins,
    wildcard,
    // `true` makes the cors middleware reflect the requesting origin, which is
    // the only way '*' can work at all — the spec forbids a literal '*' in
    // Access-Control-Allow-Origin on a credentialed response.
    origin: wildcard ? true : origins,
    // Never reflect an arbitrary origin AND allow credentials. Reflecting any
    // origin is a deliberate local-dev convenience; credentials are not needed
    // for this API, so the dangerous half is dropped rather than both kept.
    credentials: !wildcard,
  }
}

/**
 * Where Stripe is allowed to send a buyer back to.
 *
 * `createTokenCheckout` passed the client's `successUrl`/`cancelUrl` straight to
 * Stripe, so the post-payment redirect was caller-controlled. The PRICE was never
 * at risk — the block is looked up server-side by index — but an open redirect
 * bound for a payment flow is not something to leave in place, and it stops being
 * theoretical the moment the dock can buy credits with a widget token.
 *
 * The rule is "back to where the request came from", not an invented allowlist:
 * the browser sends `Origin` on this cross-origin call, and the CORS middleware
 * has already refused any origin that is not allowed before a handler runs. So
 * the trusted base is the request's own origin, and anything else — a foreign
 * origin, a malformed URL, nothing at all — lands on the base plus `path` rather
 * than being refused, because a buyer who has just paid must always land
 * somewhere real.
 *
 * Pure and exported so the rule is testable without a server or a Stripe key.
 *
 * @param {string} raw          the client's proposed return URL
 * @param {string} path         where to land when it is not acceptable
 * @param {string} baseOrigin   the origin the request came from (or FRONTEND_URL)
 * @returns {string}
 */
export function safeReturnUrl(raw, path = '/', baseOrigin) {
  let base = DEFAULT_CORS_ORIGIN
  try {
    base = new URL(String(baseOrigin)).origin
  } catch { /* no usable base — the dev default is the documented fallback */ }

  let parsed = null
  try {
    parsed = new URL(String(raw ?? ''))
  } catch { parsed = null }

  // Same origin, path and query preserved — the app deliberately returns the
  // buyer to the page they were on, and that is fine as long as it is OUR page.
  if (parsed && parsed.origin === base) return parsed.toString()
  return `${base}${path}`
}
