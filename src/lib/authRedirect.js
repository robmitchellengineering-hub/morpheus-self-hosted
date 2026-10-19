// Where the app should send someone whose session was rejected.
//
// WHY THIS EXISTS — the redirect loop
//
// App.jsx answers an `auth_required` error by calling navigateToLogin(), which
// builds `/login?returnTo=<current path+query>`. Nothing stopped that from
// running WHILE ALREADY ON /login, so a rejected session produced:
//
//   /login?returnTo=/workspace/x            (first redirect — correct)
//   /login?returnTo=/login?returnTo=%2F...  (the login page redirects to itself)
//   /login?returnTo=/login?returnTo=%2Flogin%3FreturnTo%3D...   (forever)
//
// Each iteration is a full page load, so it also burned the server's rate
// limit and eventually the request line was long enough to be rejected
// outright. The symptom an operator sees is an app that will not open and a
// login form they can never reach — with an EXPIRED TOKEN as the trigger, which
// is the most ordinary way to arrive at the login page.
//
// So the decision lives here, as pure functions, and the rules are:
//   1. never navigate to an auth page from an auth page;
//   2. never let a returnTo point back at an auth page (that is the loop);
//   3. never let a returnTo leave this origin (that is an open redirect).
// src/lib/authReturnTo.js already owns rule 3 for the value read out of the
// URL; this module owns rules 1 and 2 for the values the app CREATES.

/** Pages that are part of signing in. Landing on one of these is terminal. */
export const AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/auth/callback'];

/** Is this pathname itself part of the sign-in flow? */
export function isAuthPath(pathname) {
  const p = String(pathname || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return AUTH_PATHS.includes(p);
}

/**
 * Strip a returnTo that points at an auth page (or at itself).
 *
 * A returnTo of "/login..." can only mean a redirect was already attempted from
 * a sign-in page, and honouring it is what makes the loop permanent. Anything
 * unparseable, or another origin, is dropped for the same reason.
 */
export function cleanReturnTo(returnTo) {
  const raw = String(returnTo || '').trim();
  if (!raw) return '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '';
  const pathname = raw.split('?')[0];
  if (isAuthPath(pathname)) return '';
  // Nothing useful to return to, and "/" is the default anyway.
  if (pathname === '/' && raw === '/') return '';
  return raw;
}

/**
 * The URL to send someone to when their session was rejected, or null when
 * they are already somewhere a redirect would be pointless or harmful.
 *
 * Returning null rather than "/login" is the whole fix: the caller renders
 * whatever it was going to render (the login form), instead of navigating.
 */
export function loginRedirectTarget(pathname, search = '') {
  if (isAuthPath(pathname)) return null;
  const returnTo = cleanReturnTo(`${pathname || '/'}${search || ''}`);
  return returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
}
