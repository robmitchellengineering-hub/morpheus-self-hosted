// Runtime verification that an expired Google credential is never handed out as if it worked, and
// that the operator is told what to do about it.
//
// Dependency-free (source assertions plus the pure classifier), so it runs in CI's no-install job.
// Run:  node scripts/verify-google-reconnect.mjs
//
// The incident this exists for (Rob, 2026-09-28): "Doc create failed: Request had invalid
// authentication credentials. Expected OAuth 2 access token, login cookie or other valid
// authentication credential." That is Google's words, delivered by a shop tool, naming neither the
// cause nor an action — while `checkDeckGoogleConnection` live-probed and said "not connected", so
// two surfaces told two different stories about one dead credential.
//
// Three modules had the same defect, each with a comment defending it. `googleDrive.js`: "Fall
// through with the possibly-stale token; the caller's own Drive API call will surface a clear
// error if it's actually dead." `searchConsole.js`: Google's "real error ... is a better message
// than a generic local one." Both wrong the same way. Measured cause, from the backend log and the
// row itself: the connection was created 2026-09-18 04:17, its access token expired 2026-09-25
// 04:17 — SEVEN DAYS, which is how long a refresh token lasts while the OAuth app's consent screen
// is still in "Testing" — and every attempt since was refused with "Token has been expired or
// revoked."
import { readFileSync } from 'node:fs';
import { classifyRefreshFailure, reconnectMessage, GOOGLE_REFRESH_REASONS } from '../server/src/lib/googleReconnect.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the classifier tells the three failures apart');
check("Google's own wording is classified as revoked, not as a network blip",
  classifyRefreshFailure({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), 'revoked');
check('the bare error code alone is enough',
  classifyRefreshFailure({ error: 'invalid_grant' }), 'revoked');
check('an unrecognised refusal is treated as transient, and says so', classifyRefreshFailure({ error: 'server_error' }), 'network');
check('no data at all does not crash', classifyRefreshFailure(undefined), 'network');

console.log('\n2. the operator is told the cause and the way out');
const revoked = reconnectMessage('revoked', 'Command Deck Settings');
check('a revoked token names reconnecting, in the right place', /reconnect Google in Command Deck Settings/.test(revoked), true);
check('…and explains why it will lapse again', /7 days/.test(revoked) && /Testing/.test(revoked), true);
check('a missing server credential is not blamed on the operator',
  /deployment problem, not something you can fix/.test(reconnectMessage('not_configured', 'X')), true);
check('a transient failure says to try again rather than to reconnect',
  /try again in a moment/.test(reconnectMessage('network', 'X')), true);
check('every reason answers — none falls through to an empty message',
  GOOGLE_REFRESH_REASONS.every((r) => reconnectMessage(r, 'X').length > 40), true);
// …but `every` over a list this file does not PIN is a check that shrinks silently. Found 2026-09-30 by
// mutation testing: deleting 'network' from the list left this guard GREEN, because there was one fewer
// reason to check — and `classifyRefreshFailure` still RETURNS 'network' for an unrecognised refusal, so a
// user would get whatever the fallback message is instead of the one written for it. H17's shape exactly:
// a check that examined less, reporting the same "all good".
check('the reason list is pinned, so removing one cannot shrink this check',
  [...GOOGLE_REFRESH_REASONS].sort().join(','), 'network,not_configured,revoked');
check('…and the classifier can only return reasons that have a message',
  [
    classifyRefreshFailure({ error: 'invalid_grant' }),
    classifyRefreshFailure({ error: 'server_error' }),
    classifyRefreshFailure(undefined),
    classifyRefreshFailure({ error_reason: 'not_configured' }),
  ].every((r) => GOOGLE_REFRESH_REASONS.includes(r)), true);

console.log('\n3. no module hands out a token it knows is dead');
const FILES = {
  'server/src/lib/deckGoogle.js': 'Command Deck Settings',
  'server/src/lib/googleDrive.js': 'Morpheus Settings → Google Drive',
  'server/src/lib/searchConsole.js': 'Morpheus Settings → Search Console',
};
for (const [file, where] of Object.entries(FILES)) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const name = file.split('/').pop();
  // The getter must branch on the refresh RESULT, not on truthiness of a bare token/object.
  check(`${name}: the refresh result is inspected, not truthy-tested`,
    /const refreshed = await tryRefresh\w+\(row\);/.test(src) && /refreshed\.ok/.test(src), true);
  // Distance is deliberately generous: the POST-MORTEM explaining the old behaviour sits between
  // the two lines, and pinning a character count would fail the guard the next time it is edited.
  check(`${name}: a failed refresh throws instead of falling through`,
    /if \(refreshed\.ok\)[\s\S]{0,2000}?throw Object\.assign\(new Error\(reconnectMessage\(refreshed\.reason/.test(src), true);
  check(`${name}: …carrying the code the status checks branch on`,
    /code: 'GOOGLE_RECONNECT_REQUIRED'/.test(src), true);
  check(`${name}: names where to reconnect (${where})`,
    src.includes(where), true);
  check(`${name}: the refresh helper reports a reason, and still answers ok on success`,
    /return \{ ok: false, reason: 'not_configured' \};/.test(src)
    && /return \{ ok: false, reason \};/.test(src)
    && /return \{ ok: false, reason: 'network' \};/.test(src)
    && /return \{ ok: true, token: /.test(src), true);
  // The corrected comments mention the old wording in the past tense; what must be gone is the
  // present-tense claim that falling through is fine.
  check(`${name}: no longer claims falling through is fine`,
    /falls through with the/.test(src), false);
}

console.log('\n4. the status surface agrees with the operation');
const deckCheck = readFileSync(new URL('../server/src/functions/checkDeckGoogleConnection.js', import.meta.url), 'utf8');
const driveCheck = readFileSync(new URL('../server/src/functions/checkGoogleDriveConnection.js', import.meta.url), 'utf8');
for (const [name, src] of [['checkDeckGoogleConnection', deckCheck], ['checkGoogleDriveConnection', driveCheck]]) {
  check(`${name} catches the dead credential rather than 500ing on it`,
    /catch \(err\) \{[\s\S]{0,500}?err\?\.code === 'GOOGLE_RECONNECT_REQUIRED'/.test(src), true);
  check(`${name} reports needsReconnect with the reason and the message`,
    /needsReconnect: true, reason: err\.reason, message: err\.message/.test(src), true);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
