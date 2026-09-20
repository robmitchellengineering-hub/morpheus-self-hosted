// The redirect rules that keep a rejected session from becoming a loop.
//
// This is a regression test for a bug that shipped: with a rejected token, the
// app navigated /login to /login?returnTo=/login%3F... on every load — an
// unreachable login form, a burned rate limit, and eventually a request line
// too long to serve. Each case below is one of those iterations.
import { isAuthPath, cleanReturnTo, loginRedirectTarget, AUTH_PATHS } from './authRedirect.js';
import assert from 'node:assert';

// ── rule 1: never navigate to an auth page from an auth page ────────────────
for (const p of AUTH_PATHS) {
  assert.strictEqual(isAuthPath(p), true, `${p} is an auth path`);
  assert.strictEqual(loginRedirectTarget(p, ''), null, `${p} never redirects to itself`);
}
assert.strictEqual(loginRedirectTarget('/login', '?returnTo=%2Fworkspace%2Fx'), null, 'even with a returnTo, /login does not redirect');
assert.strictEqual(isAuthPath('/login/'), true, 'a trailing slash still counts');
assert.strictEqual(isAuthPath('/login?x=1'.split('?')[0]), true, 'a query does not change the path');

// A normal protected page still redirects, carrying where they were going.
assert.strictEqual(loginRedirectTarget('/workspace/abc', ''), '/login?returnTo=%2Fworkspace%2Fabc');
assert.strictEqual(loginRedirectTarget('/deck', '?tab=life'), '/login?returnTo=%2Fdeck%3Ftab%3Dlife');
assert.strictEqual(loginRedirectTarget('/', ''), '/login');

// ── rule 2: a returnTo may never point back at a sign-in page ───────────────
// This is the exact shape the loop produced.
assert.strictEqual(cleanReturnTo('/login?returnTo=%2Fworkspace%2Fx'), '');
assert.strictEqual(cleanReturnTo('/login'), '');
assert.strictEqual(cleanReturnTo('/register'), '');
assert.strictEqual(cleanReturnTo('/auth/callback?token=abc'), '');
assert.strictEqual(loginRedirectTarget('/login', '?returnTo=%2Flogin'), null);
// A legitimate nested returnTo keeps working — only auth paths are stripped.
assert.strictEqual(cleanReturnTo('/settings?tab=ai'), '/settings?tab=ai');
assert.strictEqual(cleanReturnTo('/'), '');

// ── rule 3: a returnTo may never leave this origin ──────────────────────────
for (const bad of ['//evil.com', 'https://evil.com/x', '/\\evil.com', 'javascript:alert(1)', 'evil.com', '']) {
  assert.strictEqual(cleanReturnTo(bad), '', `refused: ${bad}`);
}
assert.strictEqual(loginRedirectTarget('//evil.com', ''), '/login', 'an off-origin path yields a bare login');

// A path that merely CONTAINS an auth path is not one.
assert.strictEqual(isAuthPath('/workspace/login-history'), false);
assert.strictEqual(cleanReturnTo('/deck/login'), '/deck/login', 'only a prefix match is stripped, not a substring');

console.log('authRedirect.test.js passed');
