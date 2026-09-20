// Where a browser may be sent after an OAuth callback.
//
// WHY THIS IS ITS OWN PURE MODULE
//
// The value comes from a query string (`?returnTo=…`) and ends up in a redirect,
// which is the textbook open-redirect shape: send someone to a URL that looks
// like ours and they hand the next site their session. Two reasons it lives here
// rather than inline in the route:
//
//   1. it is security-relevant, so it is asserted directly by
//      scripts/verify-search-console.mjs against real hostile inputs, and a
//      route module cannot be imported by a dependency-free guard (it pulls in
//      express and Prisma — the H4/H12 traps);
//   2. the same rule is wanted by any future redirect-from-a-parameter, and one
//      implementation is what keeps them from disagreeing.
//
// The rule is an allow-list of SHAPE, not of destinations: a same-origin path
// only. Absolute URLs, protocol-relative URLs (`//evil.com`, which a browser
// reads as a host) and backslashes (which some clients normalise to `/`) are all
// refused.
export const DEFAULT_RETURN_TO = '/settings';

export function safeReturnTo(value, fallback = DEFAULT_RETURN_TO) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v.startsWith('/')) return fallback;
  if (v.startsWith('//')) return fallback;
  if (v.includes('\\')) return fallback;
  // A control character or newline in a Location header is a response-splitting
  // attempt, not a path.
  if (/[\u0000-\u001f\u007f]/.test(v)) return fallback;
  return v;
}
